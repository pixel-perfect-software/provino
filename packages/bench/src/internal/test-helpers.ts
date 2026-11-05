import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { BenchError, type BenchErrorCode } from '../errors.ts'
import { PACKAGE_DIR } from '../suites.ts'

/**
 * Makes a temp directory named `<prefix>…` under the OS temp dir and removes it when the test
 * ends.
 * @internal
 */
export async function scratch(t: Pick<TestContext, 'after'>, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/**
 * Makes a directory for generated suites that a runner can run: under the bench package's
 * gitignored `.suites/`, because the suites import `date-fns`, `lodash` and `zod`, which resolve
 * from the package's `node_modules` and not from the OS temp dir. It is removed when the test ends.
 * @internal
 */
export async function scratchSuites(t: Pick<TestContext, 'after'>): Promise<string> {
  const parent = join(PACKAGE_DIR, '.suites')
  await mkdir(parent, { recursive: true })
  const dir = await mkdtemp(join(parent, 'test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/**
 * A predicate for `assert.rejects` and `assert.throws`: the error is a `BenchError` with this code.
 * @internal
 */
export function code(expected: BenchErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof BenchError && error.code === expected
}
