// Files grouped by folder, for the views that show a run folder by folder: the terminal's tree and
// status map (B26 Phase 4) and the HTML report's time by folder (Phase 5). Pure: no clock, no
// terminal, no styling, and the input is never changed.

import { posix } from 'node:path'
import { groupDigits, plural } from './count.ts'

/** How a file or a suite ended, as a view draws it: the cell of the status map, the mark of a tree row. */
export type FileKind = 'pass' | 'fail' | 'skip' | 'todo'

/**
 * One file of the run, as the views need it.
 * @internal
 */
export interface FolderFile {
  /**
   * The path the run shows (`FileInfo.runPath ?? path`), POSIX: the coordinator makes both so
   * (`relativePosix`), and the grouping reads them with `node:path`'s `posix`.
   */
  readonly path: string
  /** The project's display name; `''` when it has none. */
  readonly project: string
  readonly kind: FileKind
  /** Tests that ended in the file. */
  readonly tests: number
  readonly failed: number
  /** Tests that were skipped or are todo. */
  readonly skipped: number
  readonly durationMs: number
}

/**
 * The files of one folder of one project, with their totals.
 * @internal
 */
export interface Folder<F extends FolderFile = FolderFile> {
  readonly project: string
  /** The POSIX directory of the files' run paths; `.` for files at the root. */
  readonly dir: string
  /** In path order. */
  readonly files: readonly F[]
  readonly tests: number
  readonly failed: number
  readonly skipped: number
  readonly durationMs: number
  /** Files that ended `fail`. */
  readonly filesFailed: number
}

/**
 * How a set of tests ended: `fail` when any failed, `todo` when every one is todo, `skip` when every
 * one was skipped (todo ones among them), else `pass`. The one rule for a file's kind and a suite's
 * state; `skipped` counts the skipped and the todo tests, `todo` the todo ones.
 * @internal
 */
export function outcomeOf(tests: number, failed: number, skipped: number, todo: number): FileKind {
  if (failed > 0) return 'fail'
  if (tests > 0 && skipped === tests) return todo === tests ? 'todo' : 'skip'
  return 'pass'
}

/**
 * The kind of a file: what its tests say (`outcomeOf`), except that the file's own state wins
 * where it knows more: a file that failed fails, and one skipped whole with no test to say so skips.
 * @internal
 */
export function fileKind(
  state: 'pass' | 'fail' | 'skip',
  tests: number,
  skipped: number,
  todo: number,
): FileKind {
  if (state === 'fail') return 'fail'
  const kind = outcomeOf(tests, 0, skipped, todo)
  return kind === 'pass' && state === 'skip' ? 'skip' : kind
}

/**
 * A folder's label: its project, then its directory with a closing slash (`src/cart/`, `./`).
 * @internal
 */
export function folderLabel(folder: Pick<Folder, 'project' | 'dir'>): string {
  const dir = folder.dir.endsWith('/') ? folder.dir : `${folder.dir}/`
  return folder.project === '' ? dir : `${folder.project} ${dir}`
}

/**
 * What a folder's heading says after its label: `4 files · 11 tests · 3 failed` (the failed part
 * only when a test failed).
 * @internal
 */
export function folderDetail(folder: Folder): string {
  const parts = [plural(folder.files.length, 'file'), plural(folder.tests, 'test')]
  if (folder.failed > 0) parts.push(`${groupDigits(folder.failed)} failed`)
  return parts.join(' · ')
}

/** Code-unit order: the same on every machine, which a locale compare is not. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Groups `files` by project and folder: the folders in order of project, then directory, each with
 * its files in path order and its totals. A file's folder is the POSIX `dirname` of its run path;
 * the projects of a multi-project run keep apart even when their folders share a name.
 * @internal
 */
export function groupByFolder<F extends FolderFile>(files: readonly F[]): Folder<F>[] {
  const groups = new Map<string, { project: string; dir: string; files: F[] }>()
  for (const file of files) {
    const dir = posix.dirname(file.path)
    const key = `${file.project}\u0000${dir}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { project: file.project, dir, files: [file] })
    else group.files.push(file)
  }
  const folders: Folder<F>[] = []
  for (const group of groups.values()) {
    const sorted = group.files.toSorted((a, b) => compareText(a.path, b.path))
    let tests = 0
    let failed = 0
    let skipped = 0
    let durationMs = 0
    let filesFailed = 0
    for (const file of sorted) {
      tests += file.tests
      failed += file.failed
      skipped += file.skipped
      durationMs += file.durationMs
      if (file.kind === 'fail') filesFailed++
    }
    folders.push({
      project: group.project,
      dir: group.dir,
      files: sorted,
      tests,
      failed,
      skipped,
      durationMs,
      filesFailed,
    })
  }
  return folders.sort((a, b) => compareText(a.project, b.project) || compareText(a.dir, b.dir))
}
