// What this repo's own test setup shares (B27g2, D203): the files that stay on node:test, the globs
// a migrated package's config includes, the `test` script every migrated package has, and the
// packages that are migrated. One module with no dependencies of its own, so the shared config
// (`tooling/provino/base.ts`, run by the runner), `test-shards.ts`, the migrate code and `knip.ts`
// all read the same facts. Phase 10 (the move to the pinned runner) changes `TEST_RUNNER` here.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** This checkout's built bin, repo-relative (D203; Phase 10 swaps it for the pinned runner). */
export const RUNNER_BIN = 'packages/provino/dist/cli.js'

/** The runner a migrated package's `test` script runs, from a package directory. */
export const TEST_RUNNER: string = `node ../../${RUNNER_BIN} run`

/** Where the bootstrap set is listed: repo-relative file → why it stays on node:test. */
export const BOOTSTRAP_FILE = 'tooling/provino/bootstrap.json'

/** The directories of a migrated package whose `*.test.ts` files its config includes: the one rule. */
export const TEST_ROOTS: readonly string[] = ['src', 'test', 'bench']

/** The test files a migrated package's config includes, relative to the package. */
export const INCLUDE_GLOBS: readonly string[] = TEST_ROOTS.map((root) => `${root}/**/*.test.ts`)

/** The `src` glob: the tests that sit in the package's own project, and the tests project's include. */
export const SRC_TEST_GLOB: string = INCLUDE_GLOBS[0] ?? 'src/**/*.test.ts'

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
        existsSync(join(root, dir, 'provino.config.ts')) &&
        existsSync(join(root, dir, 'package.json')),
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
 * The `test` script of the migrated package at `dir`: the runner, then `node --test` over the
 * package's bootstrap files when it has any.
 */
export function testScript(root: string, dir: string): string {
  const own = bootstrapFiles(root)
    .filter((file) => file.startsWith(`${dir}/`))
    .map((file) => file.slice(dir.length + 1))
  return own.length === 0
    ? TEST_RUNNER
    : `${TEST_RUNNER} && node --test --conditions=provino-source ${own.join(' ')}`
}
