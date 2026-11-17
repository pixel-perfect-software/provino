// A finished file as the status map and the folder totals need it: numbers and a kind, no tree.

import { toPosix } from '../../internal/posix-relative.ts'
import { type FolderFile, fileKind } from '../../internal/views/folders.ts'
import type { FinishedFile } from './state.ts'

/**
 * The file's path, project, kind and counts. Constant work: it reads what the state already kept.
 * The views group by the POSIX run path, so the path goes through `toPosix` (a Windows host's
 * native one never collapses into `.`); `separator` is the platform's, given by tests.
 * @internal
 */
export function fileOutcome(finished: FinishedFile, separator?: string): FolderFile {
  const { result } = finished
  return {
    path: toPosix(result.file.runPath ?? result.file.path, separator),
    project: result.file.project,
    kind: fileKind(result.state, finished.tests, finished.todo),
    tests: finished.tests,
    failed: finished.failed,
    skipped: finished.skipped,
    durationMs: result.durationMs,
  }
}
