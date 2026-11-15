// T9.11: the file watcher, on Node's own `fs.watch` (D117; speed: no dependency, about 0.2 ms an
// event in Track 9 §Spikes B). macOS and Windows get one recursive watch per root. Linux gets one
// plain watch per directory the walk finds, and one more for each directory that appears, so
// `node_modules` and the ignored trees hold no inotify watch (and Node 22's one watch per file is
// never used). Each raw event is `lstat`ed into an `add`, a `change` or an `unlink`; what the caller
// doesn't keep is dropped here. The coalescing is `coalesce.ts`'s.
import { type Dirent, type Stats, watch } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { BATCH, mapInBatches } from '../util.ts'
import type { WatchEvent } from './coalesce.ts'

/**
 * What a watcher watches and whom it tells.
 * @beta
 */
export interface WatcherOptions {
  /** Absolute directories, each of which must exist: every file under them may be reported. */
  readonly roots: readonly string[]
  /** Whether a file is one to report (a crawl's `keeps`, and the caller's own `isRelevant`). */
  readonly keeps: (path: string) => boolean
  /**
   * A directory the walk does not enter, and whose files are never reported. Default: a
   * `node_modules`, `.git`, `.hg` or `.sl` directory.
   */
  readonly ignoresDirectory?: (path: string) => boolean
  /**
   * One plain watch per directory (Linux's way, the default there) in place of one recursive watch
   * per root (the default elsewhere). An option so every platform can run both paths.
   */
  readonly perDirectory?: boolean
  readonly onEvent: (event: WatchEvent) => void
  /**
   * A watch that failed after it started (`EMFILE`, a root that went away), or a directory that
   * can't be read (reported once). What it throws is ignored.
   */
  readonly onError: (error: unknown) => void
  /** How a directory is watched. Default: `fs.watch` (`nodeWatch`); a test passes its own. */
  readonly watch?: WatchFunction
}

/**
 * Opens one watch of `path`: `listener` gets the name, relative to `path`, of what changed (or
 * `null` when the platform names none), and `onError` a failure after the watch started.
 * @beta
 */
export type WatchFunction = (
  path: string,
  recursive: boolean,
  listener: (name: string | null) => void,
  onError: (error: Error) => void,
) => { close(): void }

/**
 * `fs.watch` as a `WatchFunction`.
 * @beta
 */
export const nodeWatch: WatchFunction = (path, recursive, listener, onError) => {
  const handle = watch(path, { recursive, persistent: true }, (_type, name) =>
    listener(name === null ? null : name.toString()),
  )
  handle.on('error', onError)
  return handle
}

/**
 * A running watcher.
 * @beta
 */
export interface Watcher {
  /** The mtime of every file the watcher knows, by path: the walk's, then every event's. */
  readonly known: ReadonlyMap<string, number>
  /** How many `fs.watch` handles it holds. */
  readonly handles: () => number
  /** Settles once every raw event so far has been looked at and reported. */
  readonly settled: () => Promise<void>
  /** Stops every watch; nothing is reported after it. */
  close(): void
}

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.hg', '.sl'])

function defaultIgnoresDirectory(path: string): boolean {
  return SKIPPED_DIRECTORIES.has(path.slice(path.lastIndexOf(sep) + 1))
}

function codeOf(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

function isMissing(error: unknown): boolean {
  const code = codeOf(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function isDenied(error: unknown): boolean {
  const code = codeOf(error)
  return code === 'EACCES' || code === 'EPERM'
}

/** `directory` with one separator after it, also for a root such as `/`. */
function prefixOf(directory: string): string {
  return directory.endsWith(sep) ? directory : directory + sep
}

/**
 * Starts watching. It checks every root is a directory (a missing one rejects, in both modes),
 * opens the watches, and walks the roots (no symlinks; not into an ignored directory) so it knows
 * which files exist: a file it knew is `change`d, one it didn't is `add`ed. In per-directory mode a
 * directory's watch is opened before it is read, so a file made while the walk runs is either read
 * or reported. A watch that can't be opened rejects, with every watch it had opened closed again.
 * @beta
 */
export async function createWatcher(options: WatcherOptions): Promise<Watcher> {
  const ignoresDirectory = options.ignoresDirectory ?? defaultIgnoresDirectory
  const perDirectory = options.perDirectory ?? process.platform === 'linux'
  // `resolve` drops a trailing separator (but keeps `/`), so every prefix test below is exact.
  const roots = [...new Set(options.roots.map((root) => resolve(root)))]
  const known = new Map<string, number>()
  /** The kept files of each directory the walks entered, by directory. */
  const byDirectory = new Map<string, Set<string>>()
  const handles = new Map<string, { close(): void }>()
  const watchFunction = options.watch ?? nodeWatch
  /** The directories that could not be read, each reported once. */
  const denied = new Set<string>()
  let closed = false
  /** Events are handled one after another, so two events of one path can't swap. */
  let queue: Promise<void> = Promise.resolve()

  function rootOf(path: string): string | undefined {
    return roots.find((root) => path === root || path.startsWith(prefixOf(root)))
  }

  /** Whether `path` is outside every root, or under an ignored directory between a root and it. */
  function underIgnored(path: string): boolean {
    const root = rootOf(path)
    if (root === undefined || path === root) return root === undefined
    let at = prefixOf(root).length - 1
    for (;;) {
      const next = path.indexOf(sep, at + 1)
      if (next < 0) return false
      if (ignoresDirectory(path.slice(0, next))) return true
      at = next
    }
  }

  function remember(path: string, mtime: number): void {
    known.set(path, mtime)
    const directory = dirname(path)
    let files = byDirectory.get(directory)
    if (files === undefined) {
      files = new Set()
      byDirectory.set(directory, files)
    }
    files.add(path)
  }

  function forget(path: string): boolean {
    byDirectory.get(dirname(path))?.delete(path)
    return known.delete(path)
  }

  function report(event: WatchEvent): void {
    if (!closed) options.onEvent(event)
  }

  function fail(error: unknown): void {
    if (closed) return
    try {
      options.onError(error)
    } catch {
      // A failing `onError` must not stop the watcher's queue.
    }
  }

  function enqueue(work: () => Promise<void>): void {
    queue = queue.then(work).catch(fail)
  }

  /**
   * Every directory and kept file under `directory`, with the files' mtimes, opening each
   * directory's watch before reading it in per-directory mode. A directory that is gone is
   * skipped; one that can't be read (`EACCES`, `EPERM`) is skipped and reported once.
   */
  async function walk(
    directory: string,
    directories: Set<string>,
    files: Map<string, number>,
  ): Promise<void> {
    if (perDirectory) {
      try {
        open(directory, false)
      } catch (error) {
        if (isMissing(error)) return
        if (!isDenied(error)) throw error
      }
    }
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) return
      if (!isDenied(error)) throw error
      if (!denied.has(directory)) {
        denied.add(directory)
        fail(error)
      }
      return
    }
    directories.add(directory)
    if (!byDirectory.has(directory)) byDirectory.set(directory, new Set())
    const found: string[] = []
    const below: string[] = []
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!ignoresDirectory(path)) below.push(path)
      } else if (entry.isFile() && options.keeps(path)) found.push(path)
    }
    const stats = await mapInBatches(found, BATCH, (path) =>
      lstat(path).then(
        (stat) => stat.mtimeMs,
        () => undefined,
      ),
    )
    for (const [index, path] of found.entries()) {
      const mtime = stats[index]
      if (mtime !== undefined) files.set(path, mtime)
    }
    for (const path of below) await walk(path, directories, files)
  }

  function open(path: string, recursive: boolean): void {
    if (closed || handles.has(path)) return
    const handle = watchFunction(
      path,
      recursive,
      (name) => {
        if (name === null) {
          // Some platforms name no file: look at what the watch covers again.
          enqueue(() => refresh(path))
          return
        }
        // A plain watch of a directory that is removed or moved names the directory itself.
        if (!recursive && name === basename(path)) enqueue(async () => void (await check(path)))
        const changed = join(path, name)
        enqueue(() => look(changed))
      },
      (error) => {
        // A watched directory that was removed ends its watch: that is its files' `unlink`s and no
        // error, unless it is a root. Anything else (`EMFILE`) is reported.
        enqueue(async () => {
          if (!(await check(path))) throw error
        })
      },
    )
    handles.set(path, handle)
  }

  /** Closes the watches at or under `directory`. */
  function closeUnder(directory: string): void {
    const prefix = prefixOf(directory)
    for (const [path, handle] of handles) {
      if (path === directory || path.startsWith(prefix)) {
        handle.close()
        handles.delete(path)
      }
    }
  }

  /** The directory went away: its files are unlinked, its watches closed. */
  function gone(directory: string): void {
    const prefix = prefixOf(directory)
    if (perDirectory) closeUnder(directory)
    for (const dir of [...byDirectory.keys()]) {
      if (dir !== directory && !dir.startsWith(prefix)) continue
      for (const file of byDirectory.get(dir) ?? []) {
        known.delete(file)
        report({ kind: 'unlink', path: file, mtimeMs: undefined })
      }
      byDirectory.delete(dir)
    }
  }

  /**
   * Whether the watched `directory` is gone; if so its files are unlinked, and a root that is gone
   * is reported (nothing under it can be watched any more).
   */
  async function check(directory: string): Promise<boolean> {
    const missing = await lstat(directory).then(
      (stat) => !stat.isDirectory(),
      (error: unknown) => isMissing(error),
    )
    if (!missing) return false
    gone(directory)
    if (roots.includes(directory)) {
      fail(
        Object.assign(new Error(`The watched directory ${directory} is gone`), { code: 'ENOENT' }),
      )
    }
    return true
  }

  /**
   * Walks `directory` again (a new or recreated directory, or a watch that named nothing): its
   * watches are opened anew in per-directory mode, a file with a new mtime is reported, and a file
   * it knew that the walk didn't find is unlinked.
   */
  async function refresh(directory: string): Promise<void> {
    if (perDirectory) closeUnder(directory)
    const directories = new Set<string>()
    const files = new Map<string, number>()
    await walk(directory, directories, files)
    const prefix = prefixOf(directory)
    for (const dir of [...byDirectory.keys()]) {
      if (dir !== directory && !dir.startsWith(prefix)) continue
      for (const file of [...(byDirectory.get(dir) ?? [])]) {
        if (files.has(file)) continue
        forget(file)
        report({ kind: 'unlink', path: file, mtimeMs: undefined })
      }
      if (!directories.has(dir)) byDirectory.delete(dir)
    }
    for (const [path, mtime] of files) {
      const before = known.get(path)
      if (before === mtime) continue
      remember(path, mtime)
      report({ kind: before === undefined ? 'add' : 'change', path, mtimeMs: mtime })
    }
  }

  /**
   * A file it didn't know appeared in `directory`: a rename may have named only its new name (a
   * recursive watch on some platforms), so the files it knew there that are gone are unlinked.
   */
  async function unlinkMissingSiblings(directory: string): Promise<void> {
    const siblings = byDirectory.get(directory)
    if (siblings === undefined || siblings.size === 0) return
    let names: string[]
    try {
      names = await readdir(directory)
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    const present = new Set(names.map((name) => join(directory, name)))
    for (const file of [...siblings]) {
      if (present.has(file)) continue
      forget(file)
      report({ kind: 'unlink', path: file, mtimeMs: undefined })
    }
  }

  /** What happened to `path`, from what `lstat` says now and what was known before. */
  async function look(path: string): Promise<void> {
    if (closed || underIgnored(path)) return
    let stat: Stats | undefined
    try {
      stat = await lstat(path)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    if (stat === undefined) {
      if (forget(path)) report({ kind: 'unlink', path, mtimeMs: undefined })
      // A directory that went away takes its files with it; any other unknown path (an editor's
      // temp file) costs nothing more.
      else if (byDirectory.has(path)) gone(path)
      return
    }
    if (stat.isDirectory()) {
      if (!ignoresDirectory(path)) await refresh(path)
      return
    }
    if (!stat.isFile() || !options.keeps(path)) return
    const before = known.get(path)
    // An access (a touch, a chmod) is no change: ChangeQueue.ts L96-104.
    if (before === stat.mtimeMs) return
    if (before === undefined) await unlinkMissingSiblings(dirname(path))
    remember(path, stat.mtimeMs)
    report({ kind: before === undefined ? 'add' : 'change', path, mtimeMs: stat.mtimeMs })
  }

  try {
    for (const root of roots) {
      const stat = await lstat(root)
      if (!stat.isDirectory()) {
        throw Object.assign(new Error(`The watched root ${root} is not a directory`), {
          code: 'ENOTDIR',
        })
      }
    }
    if (!perDirectory) for (const root of roots) open(root, true)
    // The first walk goes first in the queue: an event that comes while it runs is looked at
    // after it, against what it found.
    const first = (async () => {
      const files = new Map<string, number>()
      for (const root of roots) await walk(root, new Set(), files)
      for (const [path, mtime] of files) remember(path, mtime)
    })()
    queue = first.catch(() => {})
    await first
  } catch (error) {
    closed = true
    for (const handle of handles.values()) handle.close()
    handles.clear()
    throw error
  }

  return {
    known,
    handles: () => handles.size,
    settled: () => queue,
    close() {
      closed = true
      for (const handle of handles.values()) handle.close()
      handles.clear()
    },
  }
}
