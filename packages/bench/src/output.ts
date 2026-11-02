import { constants, type Stats } from 'node:fs'
import { access, lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { BenchError } from './errors.ts'

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Checks, before a bench starts, that a record can be written to `path`: nothing exists there (a
 * record is never overwritten, and an existing directory is no place for one) and the directory
 * holding it can be created and written. Creates that directory. Throws `BENCH_OUT_INVALID`.
 * @public
 */
export async function prepareOutput(path: string): Promise<void> {
  const invalid = (message: string, cause?: unknown): BenchError =>
    new BenchError(
      'BENCH_OUT_INVALID',
      `${path} ${message}`,
      cause === undefined ? undefined : { cause },
    )
  let existing: Stats | undefined
  try {
    existing = await lstat(path)
  } catch (cause) {
    if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) {
      throw invalid(`cannot be checked: ${reason(cause)}`, cause)
    }
  }
  if (existing?.isDirectory()) throw invalid('is a directory; --out names a file')
  if (existing !== undefined) throw invalid('already exists; a record is never overwritten')
  const dir = dirname(path)
  try {
    await mkdir(dir, { recursive: true })
    await access(dir, constants.W_OK)
  } catch (cause) {
    throw invalid(`cannot be written: ${reason(cause)}`, cause)
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Writes `text` to `path` so that a crash can't leave a truncated file and an existing file is
 * never replaced: it is written and synced to `<path>.<pid>.tmp` (created exclusively), checked
 * once more that `path` is still free, and renamed into place. If the write itself fails the temp
 * file is removed; if only the final rename is refused, the temp file is kept, complete, and the
 * error names it. Throws `BENCH_OUT_WRITE_FAILED`.
 * @public
 */
export async function writeRecordFile(path: string, text: string): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`
  let written = false
  try {
    const handle = await open(temp, 'wx')
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    written = true
    if (await exists(path)) throw new Error(`${path} appeared while the bench was running`)
    await rename(temp, path)
  } catch (cause) {
    // Best effort: the original failure is what gets reported.
    if (!written) await rm(temp, { force: true }).catch(() => undefined)
    throw new BenchError(
      'BENCH_OUT_WRITE_FAILED',
      written
        ? `could not move the record to ${path}: ${reason(cause)}. The complete record is in ${temp}`
        : `could not write the record to ${path}: ${reason(cause)}`,
      { cause },
    )
  }
}
