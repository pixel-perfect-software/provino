// A finished file as the status map and the folder totals need it: numbers and a kind, no tree.

import { type FolderFile, fileKind } from '../../internal/views/folders.ts'
import type { FinishedFile } from './state.ts'

/**
 * The file's path, project, kind and counts. Constant work: it reads what the state already kept.
 * @internal
 */
export function fileOutcome(finished: FinishedFile): FolderFile {
  const { result } = finished
  return {
    path: result.file.runPath ?? result.file.path,
    project: result.file.project,
    kind: fileKind(result.state, finished.tests, finished.todo),
    tests: finished.tests,
    failed: finished.failed,
    skipped: finished.skipped,
    durationMs: result.durationMs,
  }
}
