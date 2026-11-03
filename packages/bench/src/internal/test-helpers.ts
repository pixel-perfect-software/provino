import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { BenchError, type BenchErrorCode } from '../errors.ts'

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
 * A predicate for `assert.rejects` and `assert.throws`: the error is a `BenchError` with this code.
 * @internal
 */
export function code(expected: BenchErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof BenchError && error.code === expected
}
