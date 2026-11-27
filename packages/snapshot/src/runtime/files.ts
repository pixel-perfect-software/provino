// The worker's file I/O for snapshots: read a `.snap` file, write one so that a reader never sees
// half of it (a temp file in the same directory, then a rename).
import { existsSync, readFileSync } from 'node:fs'
import {
  checkSnapHeader,
  evaluateSnapFile,
  type SnapshotData,
  SnapshotError,
  type SnapshotUpdateMode,
} from '@provino/snapshot'

export { writeFileAtomically } from '../write-atomically.ts'

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
