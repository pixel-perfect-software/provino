// What this repo's own test setup shares (B27g2, D191): the files that stay on node:test, the globs
// a migrated package's config includes, the `test` script every migrated package has, and the
// packages that are migrated. One module with no dependencies of its own, so the shared config
// (`tooling/provino/base.ts`, run by the runner), `test-shards.ts`, the migrate code and `knip.ts`
// all read the same facts. The runner is the pinned rc (`provino-runner`, D191), never the checkout.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The pinned runner's bin (the root's `provino-runner` devDependency, D191), repo-relative. */
export const RUNNER_BIN = 'node_modules/provino-runner/dist/cli.js'

/** The runner a migrated package's `test` script runs, from a package directory. */
export const TEST_RUNNER: string = `node ../../${RUNNER_BIN} run`

/**
 * The build a migrated package's `test` task waits for (its turbo `dependsOn`; `provino`'s own is
 * `build`): `provino`'s, whose `^build` builds every package. The runner is installed, not built,
 * but a nested run's forked workers find their entry with Node's own resolution
 * (`import.meta.resolve('@provino/orchestrator/worker/main')`), and the runner's process has no
 * `provino-source` condition to hand them, so they load each package's `dist`. D206's `execArgv`
 * key, in a pinned rc, lets it go.
 */
export const TEST_BUILD = 'provino#build'

/** A migrated package's turbo `test.dependsOn`, as the scaffold writes it. */
export const TEST_DEPENDS_ON: readonly string[] = ['transit', TEST_BUILD]

/**
 * The packages whose test files CI splits across its shards (`test-shards.ts`): `provino`'s
 * end-to-end tests are more than half the workspace's test time, so each shard runs half its files.
 */
export const SPLIT_PACKAGES: readonly string[] = ['provino']

/** Where a split package's script reads its shard: `<n>/<of>`, set by `test-shards.ts run`; unset, every file. */
export const SHARD_VARIABLE = 'PROVINO_TEST_SHARD'

/**
 * The shard `SHARD_VARIABLE` names (`<n>/<of>`), or `undefined` when it is unset or empty (every
 * file runs); anything else is refused. Both shard wrappers (`runner-shard.ts`, `node-test.ts`)
 * read it so.
 */
export function shardOf(shard: string | undefined): string | undefined {
  if (shard === undefined || shard === '') return undefined
  if (!/^[1-9]\d*\/[1-9]\d*$/.test(shard)) {
    throw new RangeError(`${SHARD_VARIABLE} must be <n>/<of>, got ${shard}`)
  }
  return shard
}

/**
 * The runner a split package's `test` script runs: `TEST_RUNNER` with `--shard` from
 * `SHARD_VARIABLE` (`runner-shard.ts`), as its node:test half runs through `node-test.ts`.
 */
export const SPLIT_TEST_RUNNER = 'node ../../tooling/packaging/src/runner-shard.ts'

/** `node --test` with `--test-shard` from `SHARD_VARIABLE` ahead of the files (`node-test.ts`). */
export const SPLIT_NODE_TEST = 'node ../../tooling/packaging/src/node-test.ts'

/** Where the bootstrap set is listed: repo-relative file → why it stays on node:test. */
export const BOOTSTRAP_FILE = 'tooling/provino/bootstrap.json'

/** The directories of a migrated package whose `*.test.ts` files its config includes: the one rule. */
export const TEST_ROOTS: readonly string[] = ['src', 'test', 'bench']

/** The test files a migrated package's config includes, relative to the package. */
export const INCLUDE_GLOBS: readonly string[] = TEST_ROOTS.map((root) => `${root}/**/*.test.ts`)

/** The `src` glob: the tests that sit in the package's own project, and the tests project's include. */
export const SRC_TEST_GLOB: string = INCLUDE_GLOBS[0] ?? 'src/**/*.test.ts'

/** The shared config's values every migrated package's config and `verify`'s scratch config use (D193, D194). */
export const SHARED_CONFIG_VALUES: {
  isolation: 'registry'
  timeouts: { test: number; hook: number }
  resolve: { conditions: string[] }
} = {
  isolation: 'registry',
  /** node:test had no timeout and CI's job limit is the outer bound, so tests and hooks get 120 s. */
  timeouts: { test: 120_000, hook: 120_000 },
  resolve: { conditions: ['provino-source'] },
}

/** The node flag that resolves `provino-source` (the workspace's TypeScript sources). */
export const CONDITIONS_FLAG: string = `--conditions=${SHARED_CONFIG_VALUES.resolve.conditions[0]}`

/** The file a migrated package's Provino config lives in. */
export const PACKAGE_CONFIG = 'provino.config.ts'

/** Joins the runner and the `node --test` part of a migrated package's `test` script. */
export const SCRIPT_JOIN = ' && '

/** The two runners a migrated package's script starts with: `TEST_RUNNER`, or a split package's. */
export const MIGRATED_RUNNERS: readonly string[] = [TEST_RUNNER, SPLIT_TEST_RUNNER]

/** Whether a `test` script is `testScript`'s shape: a runner, then optionally its bootstrap files. */
export function isMigratedScript(script: string | undefined): boolean {
  return MIGRATED_RUNNERS.some(
    (runner) => script === runner || script?.startsWith(`${runner}${SCRIPT_JOIN}`) === true,
  )
}

/** Whether the package at `dir` (its `package.json` name) is one of `SPLIT_PACKAGES`. */
function isSplit(root: string, dir: string): boolean {
  const manifest = join(root, dir, 'package.json')
  if (!existsSync(manifest)) return false
  const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { readonly name?: unknown }
  return typeof name === 'string' && SPLIT_PACKAGES.includes(name)
}

/** The one file the bootstrap set must always hold: the runner's canary. */
export const CANARY = 'packages/provino/test/bootstrap/canary.test.ts'

/** The repo-relative files that stay on node:test, sorted. */
export function bootstrapFiles(root: string): readonly string[] {
  const parsed = JSON.parse(readFileSync(join(root, BOOTSTRAP_FILE), 'utf8')) as {
    readonly files: Readonly<Record<string, string>>
  }
  return Object.keys(parsed.files).sort()
}

/**
 * The repo-relative directories with a `provino.config.ts` of their own, sorted, found under the
 * `root` given (never the working directory). Plain `readdirSync`: `fs.globSync` is experimental on
 * Node 22.15 and prints a warning into every run that imports this module.
 */
export function migratedDirs(root: string): readonly string[] {
  return ['packages', 'tooling']
    .flatMap((base) =>
      readdirSync(join(root, base), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${base}/${entry.name}`),
    )
    .filter(
      (dir) =>
        existsSync(join(root, dir, PACKAGE_CONFIG)) && existsSync(join(root, dir, 'package.json')),
    )
    .sort()
}

/** Whether a package-relative path is one a migrated package's config includes (`TEST_ROOTS`). */
export function isIncludedTestFile(relative: string): boolean {
  return (
    relative.endsWith('.test.ts') &&
    TEST_ROOTS.some((root) => relative.startsWith(`${root}/`) && relative.length > root.length + 9)
  )
}

/**
 * Every `*.test.ts` a migrated package's config includes (under `TEST_ROOTS`, `node_modules` left
 * out), relative to the package with `/` separators, sorted: what Provino discovers before the
 * bootstrap set takes some away. The completeness test and the import scan list the same files.
 */
export function testFilesOf(packageDir: string): string[] {
  return TEST_ROOTS.filter((root) => existsSync(join(packageDir, root)))
    .flatMap((root) =>
      readdirSync(join(packageDir, root), { recursive: true, encoding: 'utf8' })
        .map((entry) => `${root}/${entry.split('\\').join('/')}`)
        .filter((path) => !path.includes('/node_modules/')),
    )
    .filter(isIncludedTestFile)
    .sort()
}

/**
 * The `test` script of the migrated package at `dir`: the runner, then `node --test` over the
 * package's bootstrap files when it has any. A split package (`SPLIT_PACKAGES`) runs both halves
 * through the shard wrappers, so each CI shard takes its share of the Provino files and of the
 * bootstrap files, and every file is in exactly one shard.
 */
export function testScript(root: string, dir: string): string {
  const own = bootstrapFiles(root)
    .filter((file) => file.startsWith(`${dir}/`))
    .map((file) => file.slice(dir.length + 1))
  const split = isSplit(root, dir)
  const runner = split ? SPLIT_TEST_RUNNER : TEST_RUNNER
  const nodeTest = split ? SPLIT_NODE_TEST : 'node --test'
  return own.length === 0
    ? runner
    : `${runner}${SCRIPT_JOIN}${nodeTest} ${CONDITIONS_FLAG} ${own.join(' ')}`
}
