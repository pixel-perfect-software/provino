// CI runs the workspace's tests as two shards per Node version (the `test` job in ci.yml). `provino`
// (the end-to-end tests through the bin) is more than half the workspace's test time, so no whole-
// package split can balance it: it runs in both shards, each taking its share of the files from the
// `PROVINO_TEST_SHARD` variable: the Provino half through `runner-shard.ts` (`provino run --shard`)
// and the bootstrap files through `node-test.ts` (Node's `--test-shard`, which Node ignores after
// the script's globs), the two halves of its `testScript`. Shard 1 also names the other packages it runs; shard 2 is every
// remaining package, so a new package lands in shard 2 without an edit. `check` proves that, from
// Turborepo's own dry run: each package with a `test` script is in exactly one shard (a split
// package in every shard), and a name listed here that no longer exists fails rather than shrinking
// shard 1 unnoticed.
//
//   node tooling/packaging/src/test-shards.ts check
//   node tooling/packaging/src/test-shards.ts run <1|2> [turbo run flags…]
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bootstrapFiles,
  CANARY,
  INCLUDE_GLOBS,
  isIncludedTestFile,
  isMigratedScript,
  migratedDirs,
  PACKAGE_CONFIG,
  SPLIT_PACKAGES,
  SPLIT_TEST_RUNNER,
  testScript,
} from './dogfood.ts'
import { importProblems } from './node-test-imports.ts'
import { ROOT, readWorkspacePackages } from './workspace.ts'

/**
 * Whether a split package's `test` script takes its share of a shard: a migrated one's runs its
 * Provino half through `runner-shard.ts` (`SPLIT_TEST_RUNNER`; `bootstrapProblems` holds the rest to
 * `testScript`, which runs the bootstrap half through `node-test.ts`), an unmigrated one's runs
 * `node --test` through `node-test.ts`. Any other runs every file in every shard.
 * @internal
 */
export function shardableScript(script: string): boolean {
  return isMigratedScript(script)
    ? script.startsWith(SPLIT_TEST_RUNNER)
    : script.includes('/node-test.ts ')
}

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

/**
 * One package that runs on Provino (it has a `provino.config.ts`), as `check` sees it.
 * @internal
 */
export interface MigratedPackage {
  readonly name: string
  /** Repo-relative directory: `packages/lazy`. */
  readonly dir: string
  /** What its `test` script says, and what `testScript` says it must (one string for every package). */
  readonly script: string
  readonly expectedScript: string
}

/**
 * What is wrong with the bootstrap set (`tooling/provino/bootstrap.json`) and the migrated packages'
 * scripts. A migrated package's script is the runner, then `node --test` over exactly its bootstrap
 * files, so each test file runs on exactly one runner: the shared config excludes the set from
 * Provino's `include`, and the script runs the set on node:test. The set must hold the canary, and
 * every entry must exist and, if it is in a migrated package, be named by that script.
 * @internal
 */
export function bootstrapProblems(
  bootstrap: readonly string[],
  packages: readonly MigratedPackage[],
  exists: (file: string) => boolean,
  /** The directories with a `provino.config.ts` (`migratedDirs`): each must be one of `packages`. */
  dirs: readonly string[],
): readonly string[] {
  const problems: string[] = []
  // A guard that finds nothing to guard must fail: a malformed manifest would otherwise drop a
  // package from the script and glob checks without a word.
  if (dirs.length === 0) problems.push(`no migrated package (a ${PACKAGE_CONFIG}) was found`)
  for (const dir of dirs) {
    if (!packages.some((pkg) => pkg.dir === dir)) {
      problems.push(
        `${dir} has a ${PACKAGE_CONFIG} but is not a readable workspace package (its package.json?)`,
      )
    }
  }
  if (!bootstrap.includes(CANARY)) problems.push(`the bootstrap set must hold ${CANARY}`)
  for (const file of bootstrap) {
    if (!exists(file)) problems.push(`bootstrap file ${file} does not exist`)
    const owner = packages.find((pkg) => file.startsWith(`${pkg.dir}/`))
    // The canary is the one entry outside a migrated package, until `provino`'s own suite migrates
    // (Phase 8): then its package owns it and the checks below apply.
    if (file === CANARY && owner === undefined) continue
    if (owner === undefined) {
      problems.push(
        `bootstrap file ${file} is not in a migrated package (one with a ${PACKAGE_CONFIG})`,
      )
    } else if (!isIncludedTestFile(file.slice(owner.dir.length + 1))) {
      problems.push(
        `bootstrap file ${file} is matched by none of ${owner.name}'s include globs (${INCLUDE_GLOBS.join(', ')})`,
      )
    }
  }
  for (const pkg of packages) {
    if (pkg.script !== pkg.expectedScript) {
      problems.push(
        `${pkg.name}'s test script is "${pkg.script}", expected "${pkg.expectedScript}": a file of the bootstrap set must run on node:test only, every other on Provino only`,
      )
    }
  }
  return problems
}

/** The packages with a `provino.config.ts`, read from disk; the root config's projects are these. */
function migratedPackages(): readonly MigratedPackage[] {
  const dirs = migratedDirs(ROOT)
  return readWorkspacePackages()
    .filter((pkg) => dirs.includes(pkg.rel))
    .map((pkg) => ({
      name: pkg.manifest.name,
      dir: pkg.rel,
      script: pkg.manifest.scripts?.test ?? '',
      expectedScript: testScript(ROOT, pkg.rel),
    }))
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

/** The split packages whose `test` script runs every file whatever the shard. */
function unshardableSplits(): readonly string[] {
  return readWorkspacePackages()
    .filter((pkg) => SPLIT_PACKAGES.includes(pkg.manifest.name))
    .filter((pkg) => !shardableScript(pkg.manifest.scripts?.test ?? ''))
    .map((pkg) => pkg.manifest.name)
}

function check(): number {
  const ran = Array.from({ length: SHARD_COUNT }, (_, index) => plannedPackages(index + 1))
  const problems = [
    ...shardProblems(packagesWithTests(), ran),
    ...bootstrapProblems(
      bootstrapFiles(ROOT),
      migratedPackages(),
      (file) => existsSync(join(ROOT, file)),
      migratedDirs(ROOT),
    ),
    ...importProblems(ROOT),
    ...unshardableSplits().map(
      (name) =>
        `${name} is split but its test script does not take a shard (runner-shard.ts, node-test.ts)`,
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
