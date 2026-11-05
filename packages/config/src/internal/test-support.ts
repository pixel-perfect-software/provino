// Test helpers for config's own unit tests (not a test file): real files in a temp directory, and
// an assertion that a promise rejects with a `ConfigError` of a given code.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ConfigError, type ConfigErrorCode } from '../errors.ts'

/** A temp directory whose files are written as text at test time. */
export interface TempDir {
  /** The directory, with symlinks resolved (macOS's `$TMPDIR` is one). */
  readonly dir: string
  /** Writes `text` to `name` (made relative to the directory) and returns its absolute path. */
  write(name: string, text: string): Promise<string>
  dispose(): Promise<void>
}

export async function makeTempDir(prefix = 'provino-config-'): Promise<TempDir> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  return {
    dir,
    async write(name, text) {
      const path = join(dir, name)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, text)
      return path
    },
    dispose: () => rm(dir, { recursive: true, force: true }),
  }
}

/** Awaits `promise`, asserts it rejected with a `ConfigError` of `code`, and returns the error. */
export async function rejectsWith(
  promise: Promise<unknown>,
  code: ConfigErrorCode,
): Promise<ConfigError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected a ConfigError, got ${String(error)}`)
    assert.equal(error.code, code, error.message)
    return error
  }
  assert.fail(`expected a ConfigError ${code}, but it resolved`)
}
