// The worker's file I/O for snapshots: read a `.snap` file, write one so that a reader never sees
// half of it (a temp file in the same directory, then a rename).
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  checkSnapHeader,
  evaluateSnapFile,
  type SnapshotData,
  SnapshotError,
  type SnapshotUpdateMode,
} from '@provino/snapshot'

/**
 * A `.snap` file as the state starts from it.
 * @internal
 */
export interface SnapFileRead {
  readonly data: SnapshotData
  /** Whether the file exists. */
  readonly exists: boolean
  /** The file has the wrong header and the run may rewrite it: it must be saved. */
  readonly dirty: boolean
}

/**
 * Reads a snapshot file. A missing file is empty data. A file whose header isn't `header` is
 * rewritten when the mode allows writes, and is an error under `none`, which writes nothing.
 * @internal
 */
export function readSnapFile(
  path: string,
  update: SnapshotUpdateMode,
  header: string,
): SnapFileRead {
  const exists = existsSync(path)
  const text = exists ? readFileSync(path, 'utf8') : ''
  const data = evaluateSnapFile(text)
  const problem = text === '' ? null : checkSnapHeader(text, header)
  if (problem !== null && update === 'none') {
    throw new SnapshotError('SNAPSHOT_HEADER_MISMATCH', problem)
  }
  return { data, exists, dirty: problem !== null }
}

/**
 * Writes a file through a temp file in its directory, then a rename.
 * @internal
 */
export function writeFileAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    writeFileSync(temp, text)
    renameSync(temp, path)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // The temp file was never made, or is already gone; the first error is the one to report.
    }
    throw error
  }
}
