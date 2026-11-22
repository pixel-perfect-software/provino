// CI runs the workspace's tests as two shards per Node version (the `test` job in ci.yml). `provino`
// (the end-to-end tests through the bin) is more than half the workspace's test time, so no whole-
// package split can balance it: it runs in both shards, each taking half its files through Node's
// own `--test-shard=<n>/2`, which `packages/provino`'s test script reaches through `node-test.ts` and the
// `PROVINO_TEST_SHARD` variable (Node ignores the flag after the script's globs). Shard 1 also names the other packages it runs; shard 2 is every
// remaining package, so a new package lands in shard 2 without an edit. `check` proves that, from
// Turborepo's own dry run: each package with a `test` script is in exactly one shard (a split
// package in every shard), and a name listed here that no longer exists fails rather than shrinking
// shard 1 unnoticed.
//
//   node tooling/packaging/src/test-shards.ts check
//   node tooling/packaging/src/test-shards.ts run <1|2> [turbo run flags…]
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, globSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT, readWorkspacePackages } from './workspace.ts'

/**
 * Packages whose test files are split across the shards: each shard runs them with
 * `PROVINO_TEST_SHARD=<n>/SHARD_COUNT`, and their test script must run through `node-test.ts`.
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
  '@provino/orchestrator',
  '@provino/bench',
  '@provino/snapshot',
  '@provino/config',
  '@provino/policy',
  '@provino/env-node',
]

/** @internal */
export const SHARD_COUNT = 2

/**
 * What one shard's Turborepo run takes: the filters that select its packages and the environment
 * that gives each split package its half of the files (1-based). `check`'s dry run and `run` both
 * read it, so they can't drift apart.
 * @internal
 */
export function shardInvocation(shard: number): {
  readonly filters: readonly string[]
  readonly env: Readonly<Record<string, string>>
} {
  if (!Number.isInteger(shard) || shard < 1 || shard > SHARD_COUNT) {
    throw new RangeError(`there are ${SHARD_COUNT} test shards; got ${shard}`)
  }
  const filters =
    shard === 1
      ? [...SPLIT_PACKAGES, ...SHARD_ONE].map((name) => `--filter=${name}`)
      : SHARD_ONE.map((name) => `--filter=!${name}`)
  return { filters, env: { PROVINO_TEST_SHARD: `${shard}/${SHARD_COUNT}` } }
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
  for (const name of [...SHARD_ONE, ...SPLIT_PACKAGES]) {
    if (!testPackages.includes(name)) {
      problems.push(`test-shards.ts names ${name}, which is not a package with a test script`)
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

/** Where the files that stay on node:test are listed (B27g2, D203). */
const BOOTSTRAP_FILE = 'tooling/provino/bootstrap.json'

/** The one file the bootstrap set must always hold: the runner's canary. */
export const CANARY = 'packages/provino/test/bootstrap/canary.test.ts'

/**
 * One package that runs on Provino (it has a `provino.config.ts`): its test files (repo-relative)
 * and the ones its `test` script still hands to `node --test`.
 * @internal
 */
export interface MigratedPackage {
  readonly name: string
  readonly files: readonly string[]
  readonly nodeTestFiles: readonly string[]
}

/**
 * What is wrong with the bootstrap set (`tooling/provino/bootstrap.json`): a file Provino skips
 * must be run by the package's node:test step, and one node:test runs must be on the list, so each
 * test file of a migrated package runs on exactly one runner. Also: an entry that is not a file, and
 * a set without the canary.
 * @internal
 */
export function bootstrapProblems(
  bootstrap: readonly string[],
  packages: readonly MigratedPackage[],
  exists: (file: string) => boolean,
): readonly string[] {
  const problems: string[] = []
  const listed = new Set(bootstrap)
  if (!listed.has(CANARY)) problems.push(`the bootstrap set must hold ${CANARY}`)
  for (const file of bootstrap) {
    if (!exists(file)) problems.push(`bootstrap file ${file} does not exist`)
  }
  for (const pkg of packages) {
    const viaNodeTest = new Set(pkg.nodeTestFiles)
    for (const file of pkg.files) {
      const skipped = listed.has(file)
      const named = viaNodeTest.has(file)
      if (skipped && !named)
        problems.push(
          `${file} is in the bootstrap set but ${pkg.name}'s test script does not run it: it runs on neither runner`,
        )
      if (!skipped && named)
        problems.push(
          `${file} is run by node --test in ${pkg.name}'s test script but is not in the bootstrap set: it runs on both runners`,
        )
    }
    for (const file of pkg.nodeTestFiles) {
      if (!pkg.files.includes(file))
        problems.push(`${pkg.name}'s test script names ${file}, which is not one of its test files`)
    }
  }
  return problems
}

/** The test files a migrated package's config includes, as `tooling/provino/base.ts` names them. */
const INCLUDE_GLOBS = ['src/**/*.test.ts', 'test/**/*.test.ts', 'bench/**/*.test.ts']

/** The packages with a `provino.config.ts`, read from disk. */
function migratedPackages(): readonly MigratedPackage[] {
  return readWorkspacePackages()
    .filter((pkg) => pkg.rel !== '.' && existsSync(join(pkg.dir, 'provino.config.ts')))
    .map((pkg) => {
      const rel = (file: string): string => `${pkg.rel}/${file.split('\\').join('/')}`
      const script = pkg.manifest.scripts?.test ?? ''
      const nodeTest = script.includes('node --test')
        ? script.slice(script.indexOf('node --test'))
        : ''
      return {
        name: pkg.manifest.name,
        files: INCLUDE_GLOBS.flatMap((pattern) =>
          globSync(pattern, { cwd: pkg.dir, exclude: (name) => name === 'node_modules' }),
        )
          .map(rel)
          .sort(),
        nodeTestFiles: nodeTest
          .split(/\s+/)
          .filter((word) => /\.test\.ts$/.test(word))
          .map((word) => rel(word.replaceAll(/^["']|["']$/g, ''))),
      }
    })
}

function bootstrapFiles(): readonly string[] {
  const parsed = JSON.parse(readFileSync(join(ROOT, BOOTSTRAP_FILE), 'utf8')) as {
    readonly files: Readonly<Record<string, string>>
  }
  return Object.keys(parsed.files)
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
  const { filters, env } = shardInvocation(shard)
  const result = spawnSync('pnpm', ['exec', 'turbo', 'run', 'test', '--dry=json', ...filters], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`turbo's dry run for shard ${shard} failed:\n${result.stderr}`)
  }
  const plan = JSON.parse(result.stdout) as DryRun
  return plan.tasks.filter((task) => task.task === 'test').map((task) => task.package)
}

/** The split packages whose `test` script does not run through `node-test.ts`. */
function unshardableSplits(): readonly string[] {
  return readWorkspacePackages()
    .filter((pkg) => SPLIT_PACKAGES.includes(pkg.manifest.name))
    .filter((pkg) => !(pkg.manifest.scripts?.test ?? '').includes('/node-test.ts '))
    .map((pkg) => pkg.manifest.name)
}

function check(): number {
  const ran = Array.from({ length: SHARD_COUNT }, (_, index) => plannedPackages(index + 1))
  const problems = [
    ...shardProblems(packagesWithTests(), ran),
    ...bootstrapProblems(bootstrapFiles(), migratedPackages(), (file) =>
      existsSync(join(ROOT, file)),
    ),
    ...unshardableSplits().map(
      (name) => `${name} is split but its test script does not run through node-test.ts`,
    ),
  ]
  if (problems.length > 0) {
    for (const problem of problems) console.error(`test shards: ${problem}`)
    return 1
  }
  for (const [index, names] of ran.entries()) {
    console.log(`shard ${index + 1}/${SHARD_COUNT}: ${names.length} packages`)
  }
  return 0
}

/** One Turborepo run: the shard's packages, and the variable that halves the split ones. */
async function run(shard: number, flags: readonly string[]): Promise<number> {
  if (check() !== 0) return 1
  const { filters, env } = shardInvocation(shard)
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['exec', 'turbo', 'run', 'test', ...flags, ...filters], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...env, PROVINO_NODE: process.version },
    })
    child.on('error', () => resolve(1))
    child.on('close', (code) => resolve(code ?? 1))
  })
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
