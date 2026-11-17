// Files grouped by folder, for the views that show a run folder by folder: the terminal's tree and
// status map (B26 Phase 4) and the HTML report's time by folder (Phase 5). Pure: no clock, no
// terminal, no styling, and the input is never changed.

/** How a file ended, as a view draws it: the cell of the status map, the mark of a tree row. */
export type FileKind = 'pass' | 'fail' | 'skip' | 'todo'

/**
 * One file of the run, as the views need it.
 * @internal
 */
export interface FolderFile {
  /** The path the run shows (`FileInfo.runPath ?? path`), POSIX. */
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
 * The kind of a file: `fail` when the file failed, `todo` when every test that ended is todo, else
 * `skip` for a file that was skipped whole and `pass` for the rest.
 * @internal
 */
export function fileKind(state: 'pass' | 'fail' | 'skip', tests: number, todo: number): FileKind {
  if (state === 'fail') return 'fail'
  if (tests > 0 && todo === tests) return 'todo'
  return state === 'skip' ? 'skip' : 'pass'
}

/**
 * The POSIX directory part of a run path: `a/b/c.test.ts` is `a/b`, `c.test.ts` is `.` and
 * `/c.test.ts` is `/`.
 * @internal
 */
export function dirnameOf(path: string): string {
  const slash = path.lastIndexOf('/')
  if (slash === -1) return '.'
  return slash === 0 ? '/' : path.slice(0, slash)
}

/**
 * The part of a run path after its directory.
 * @internal
 */
export function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
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
    const dir = dirnameOf(file.path)
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
