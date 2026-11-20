// CI runs the workspace's tests as two shards per Node version (the `test` job in ci.yml). `provino`
// (the end-to-end tests through the bin) is more than half the workspace's test time, so no whole-
// package split can balance it: it runs in both shards, each taking half its files through Node's
// own `--test-shard=<n>/2`. Shard 1 also names the other packages it runs; shard 2 is every
// remaining package, so a new package lands in shard 2 without an edit. `check` proves that, from
// Turborepo's own dry run: each package with a `test` script is in exactly one shard (a split
// package in every shard), and a name listed here that no longer exists fails rather than shrinking
// shard 1 unnoticed.
//
//   node tooling/packaging/src/test-shards.ts check
//   node tooling/packaging/src/test-shards.ts run <1|2> [turbo run flags…]
import { spawn, spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ROOT, readWorkspacePackages } from './workspace.ts'

/**
 * Packages whose test files are split across the shards: each shard runs them with
 * `--test-shard=<n>/SHARD_COUNT`.
 * @internal
 */
export const SPLIT_PACKAGES: readonly string[] = ['provino']

/**
 * The whole packages shard 1 runs besides its half of the split ones. Every other package is in
 * shard 2.
 * @internal
 */
export const SHARD_ONE: readonly string[] = [
  '@provino/dialect-jest',
  '@provino/harness',
  '@provino/orchestrator',
  '@provino/snapshot',
  '@provino/config',
  '@provino/policy',
  '@provino/env-node',
]

/**
 * Seconds each package took in CI on Node 22.15.0 (main, run 44770476921, 2026-11-20), the
 * `duration_ms` of its `node --test` summary. Packages run side by side on 4 CPUs, so a
 * duration is inflated by contention: shard 2 summed 1704 s of them in a 365 s job, a ratio of
 * 0.214 (`CONTENTION`). `provino` alone took 575 s of the 4 CPUs, `@provino/dialect-jest` 43 s.
 * A package not listed here weighs nothing in the balance test; add it when it is measured.
 * @internal
 */
export const WEIGHTS: Readonly<Record<string, number>> = {
  provino: 575 / 0.214,
  '@provino/dialect-jest': 43 / 0.214,
  '@provino/harness': 364.4,
  '@provino/orchestrator': 356.1,
  '@provino/bench': 262.5,
  '@provino/transform': 121.6,
  '@provino/reporters': 116.6,
  'provino-boundaries': 90.6,
  'provino-packaging': 83.4,
  '@provino/loader': 72.1,
  '@provino/lazy': 36.8,
  '@provino/core': 33.1,
  '@provino/dialect-vitest': 29.1,
  '@provino/coverage': 23.6,
  '@provino/env-jsdom': 20.9,
  '@provino/expect': 17.7,
  '@provino/env-shared': 16,
  '@provino/timers': 14.5,
  '@provino/mock': 14.4,
  '@provino/config': 8.3,
  '@provino/snapshot': 7.6,
  '@provino/policy': 4.5,
  '@provino/env-node': 4.4,
  '@provino/resolver': 2.4,
  '@provino/rpc': 1.9,
  '@provino/types': 1.4,
}

/** What each shard should cost, in the weights' own unit, for the balance test. @internal */
export function expectedShardCosts(): readonly number[] {
  const weight = (name: string) => WEIGHTS[name] ?? 0
  const sum = (names: readonly string[]) => names.reduce((total, name) => total + weight(name), 0)
  const split = sum(SPLIT_PACKAGES) / SHARD_COUNT
  const wholeOnes = Object.keys(WEIGHTS).filter((name) => !SPLIT_PACKAGES.includes(name))
  const shardOne = sum(SHARD_ONE) + split
  return [shardOne, sum(wholeOnes) - sum(SHARD_ONE) + split]
}

/** @internal */
export const SHARD_COUNT = 2

/**
 * The Turborepo filters that select one shard (1-based).
 * @internal
 */
export function shardFilters(shard: number): readonly string[] {
  if (shard === 1) return SHARD_ONE.map((name) => `--filter=${name}`)
  if (shard === 2) {
    return [...SHARD_ONE, ...SPLIT_PACKAGES].map((name) => `--filter=!${name}`)
  }
  throw new RangeError(`there are ${SHARD_COUNT} test shards; got ${shard}`)
}

/**
 * The Turborepo arguments that run a shard's half of the split packages: their filters, then the
 * flag Node's test runner takes after the package's own script.
 * @internal
 */
export function splitArgs(shard: number): readonly string[] {
  if (shard < 1 || shard > SHARD_COUNT) {
    throw new RangeError(`there are ${SHARD_COUNT} test shards; got ${shard}`)
  }
  return [
    ...SPLIT_PACKAGES.map((name) => `--filter=${name}`),
    '--',
    `--test-shard=${shard}/${SHARD_COUNT}`,
  ]
}

/**
 * What is wrong with the shards, given the packages that have a `test` script and the packages
 * each shard would run.
 * @internal
 */
export function shardProblems(
  testPackages: readonly string[],
  ran: readonly (readonly string[])[],
): readonly string[] {
  const problems: string[] = []
  for (const name of SHARD_ONE) {
    if (!testPackages.includes(name)) {
      problems.push(`SHARD_ONE names ${name}, which is not a package with a test script`)
    }
  }
  for (const name of SPLIT_PACKAGES) {
    if (!testPackages.includes(name)) {
      problems.push(`SPLIT_PACKAGES names ${name}, which is not a package with a test script`)
    }
  }
  for (const name of testPackages) {
    const shards = ran.flatMap((names, index) => (names.includes(name) ? [index + 1] : []))
    if (SPLIT_PACKAGES.includes(name)) {
      if (shards.length !== ran.length) {
        problems.push(
          `${name} is split and must be in every shard; it is in ${shards.join(' and ') || 'none'}`,
        )
      }
    } else if (shards.length === 0) problems.push(`${name} has tests and is in no shard`)
    else if (shards.length > 1) problems.push(`${name} is in shards ${shards.join(' and ')}`)
  }
  for (const [index, names] of ran.entries()) {
    for (const name of names) {
      if (!testPackages.includes(name)) {
        problems.push(`shard ${index + 1} ran ${name}, which is not a package with a test script`)
      }
    }
  }
  return problems
}

/** The workspace packages (not the root) that have a `test` script. */
function packagesWithTests(): readonly string[] {
  return readWorkspacePackages()
    .filter((pkg) => pkg.rel !== '.' && pkg.manifest.scripts?.test !== undefined)
    .map((pkg) => pkg.manifest.name)
}

interface DryRun {
  readonly tasks: readonly { readonly task: string; readonly package: string }[]
}

/** The packages Turborepo would run `test` for under a shard's filters, from a dry run. */
function plannedPackages(shard: number): readonly string[] {
  const dry = (filters: readonly string[]): readonly string[] => {
    const result = spawnSync('pnpm', ['exec', 'turbo', 'run', 'test', '--dry=json', ...filters], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    if (result.status !== 0) {
      throw new Error(`turbo's dry run for shard ${shard} failed:\n${result.stderr}`)
    }
    const plan = JSON.parse(result.stdout) as DryRun
    return plan.tasks.filter((task) => task.task === 'test').map((task) => task.package)
  }
  return [...dry(shardFilters(shard)), ...dry(splitArgs(shard))]
}

function check(): number {
  const ran = Array.from({ length: SHARD_COUNT }, (_, index) => plannedPackages(index + 1))
  const problems = shardProblems(packagesWithTests(), ran)
  if (problems.length > 0) {
    for (const problem of problems) console.error(`test shards: ${problem}`)
    return 1
  }
  for (const [index, names] of ran.entries()) {
    console.log(`shard ${index + 1}/${SHARD_COUNT}: ${names.length} packages`)
  }
  return 0
}

/** Turborepo twice at once: the shard's whole packages, and its half of the split ones. */
async function run(shard: number, flags: readonly string[]): Promise<number> {
  if (check() !== 0) return 1
  const turbo = (args: readonly string[]): Promise<number> =>
    new Promise((resolve) => {
      const child = spawn('pnpm', ['exec', 'turbo', 'run', 'test', ...flags, ...args], {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, PROVINO_NODE: process.version },
      })
      child.on('error', () => resolve(1))
      child.on('close', (code) => resolve(code ?? 1))
    })
  const codes = await Promise.all([turbo(shardFilters(shard)), turbo(splitArgs(shard))])
  return codes.find((code) => code !== 0) ?? 0
}

const entry = process.argv[1]
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  const [command, shardArg, ...flags] = process.argv.slice(2)
  if (command === 'check') {
    process.exitCode = check()
  } else if (command === 'run' && (shardArg === '1' || shardArg === '2')) {
    process.exitCode = await run(Number(shardArg), flags)
  } else {
    console.error('usage: test-shards.ts check | run <1|2> [turbo flags…]')
    process.exitCode = 2
  }
}
