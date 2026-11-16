// CI runs the workspace's tests as two shards per Node version (the `test` job in ci.yml). Shard 1
// names its packages; shard 2 is every other package, so a new package lands in shard 2 without an
// edit. `check` proves that, from Turborepo's own dry run: each package with a `test` script is in
// exactly one shard, and a name listed here that no longer exists fails rather than shrinking
// shard 1 unnoticed.
//
//   node tooling/packaging/src/test-shards.ts check
//   node tooling/packaging/src/test-shards.ts run <1|2> [turbo run flags…]
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ROOT, readWorkspacePackages } from './workspace.ts'

/**
 * Shard 1: the packages whose tests take the longest. `provino` (the end-to-end tests through the
 * bin) is about 40% of the workspace's test time on its own; `@provino/dialect-jest` brings shard 1
 * level with shard 2 (`@provino/harness`, `@provino/bench` and the rest). Measured on Node 24,
 * `--force`, 4 concurrent tasks (2026-11-16): provino 160 s, dialect-jest 35 s against harness 84 s,
 * bench 47 s and the others 65 s together.
 * @internal
 */
export const SHARD_ONE: readonly string[] = ['provino', '@provino/dialect-jest']

/** @internal */
export const SHARD_COUNT = 2

/**
 * The Turborepo filters that select one shard (1-based).
 * @internal
 */
export function shardFilters(shard: number): readonly string[] {
  if (shard === 1) return SHARD_ONE.map((name) => `--filter=${name}`)
  if (shard === 2) return SHARD_ONE.map((name) => `--filter=!${name}`)
  throw new RangeError(`there are ${SHARD_COUNT} test shards; got ${shard}`)
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
  for (const name of testPackages) {
    const shards = ran.flatMap((names, index) => (names.includes(name) ? [index + 1] : []))
    if (shards.length === 0) problems.push(`${name} has tests and is in no shard`)
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
  const result = spawnSync(
    'pnpm',
    ['exec', 'turbo', 'run', 'test', '--dry=json', ...shardFilters(shard)],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (result.status !== 0) {
    throw new Error(`turbo's dry run for shard ${shard} failed:\n${result.stderr}`)
  }
  const plan = JSON.parse(result.stdout) as DryRun
  return plan.tasks.filter((task) => task.task === 'test').map((task) => task.package)
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

function run(shard: number, flags: readonly string[]): number {
  if (check() !== 0) return 1
  const result = spawnSync(
    'pnpm',
    ['exec', 'turbo', 'run', 'test', ...flags, ...shardFilters(shard)],
    {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, PROVINO_NODE: process.version },
    },
  )
  return result.status ?? 1
}

const entry = process.argv[1]
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  const [command, shardArg, ...flags] = process.argv.slice(2)
  if (command === 'check') {
    process.exitCode = check()
  } else if (command === 'run' && (shardArg === '1' || shardArg === '2')) {
    process.exitCode = run(Number(shardArg), flags)
  } else {
    console.error('usage: test-shards.ts check | run <1|2> [turbo flags…]')
    process.exitCode = 2
  }
}
