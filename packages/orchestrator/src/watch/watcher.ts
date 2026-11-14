// T9.11: the file watcher, on Node's own `fs.watch` (D117; speed: no dependency, about 0.2 ms an
// event in Track 9 §Spikes B). macOS and Windows get one recursive watch per root. Linux gets one
// plain watch per directory the walk finds, and one more for each directory that appears, so
// `node_modules` and the ignored trees hold no inotify watch (and Node 22's one watch per file is
// never used). Each raw event is `lstat`ed into an `add`, a `change` or an `unlink`; what the caller
// doesn't keep is dropped here. The coalescing is `coalesce.ts`'s.
import { type Dirent, type Stats, watch } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { BATCH, mapInBatches } from '../util.ts'
import type { WatchEvent } from './coalesce.ts'

/**
 * What a watcher watches and whom it tells.
 * @beta
 */
export interface WatcherOptions {
  /** Absolute directories: every file under them may be reported. */
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
  /** A watch that failed after it started (`EMFILE`, a root that went away). */
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

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

/**
 * Starts watching. It walks the roots first (no symlinks; not into an ignored directory), so it
 * knows which files exist: a file it knew is `change`d, one it didn't is `add`ed. A watch that can't
 * be opened rejects, with every watch it had opened closed again.
 * @beta
 */
export async function createWatcher(options: WatcherOptions): Promise<Watcher> {
  const ignoresDirectory = options.ignoresDirectory ?? defaultIgnoresDirectory
  const perDirectory = options.perDirectory ?? process.platform === 'linux'
  const known = new Map<string, number>()
  const handles = new Map<string, { close(): void }>()
  const watchFunction = options.watch ?? nodeWatch
  let closed = false
  /** Events are handled one after another, so two events of one path can't swap. */
  let queue: Promise<void> = Promise.resolve()

  /** Whether `path` lies under an ignored directory between a root and it. */
  function underIgnored(path: string): boolean {
    const root = options.roots.find((candidate) => path.startsWith(candidate + sep))
    if (root === undefined) return true
    let at = root.length
    for (;;) {
      const next = path.indexOf(sep, at + 1)
      if (next < 0) return false
      if (ignoresDirectory(path.slice(0, next))) return true
      at = next
    }
  }

  /** Every directory and kept file under `directory`, with the files' mtimes. */
  async function walk(
    directory: string,
    directories: string[],
    files: Map<string, number>,
  ): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    directories.push(directory)
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
          // Some platforms name no file: look at the whole directory again.
          if (!recursive) enqueue(() => rescan(path))
          return
        }
        const changed = join(path, name)
        enqueue(() => look(changed))
      },
      (error) => {
        enqueue(async () => {
          // A watched directory that was removed ends its watch: its files' `unlink`s say so, and
          // that is no error. Anything else (`EMFILE`) is.
          const gone = await lstat(path).then(
            () => false,
            (statError: unknown) => isMissing(statError),
          )
          if (gone && !options.roots.includes(path)) closeUnder(path)
          else throw error
        })
      },
    )
    handles.set(path, handle)
  }

  function enqueue(work: () => Promise<void>): void {
    queue = queue.then(work).catch((error: unknown) => {
      if (!closed) options.onError(error)
    })
  }

  function report(event: WatchEvent): void {
    if (!closed) options.onEvent(event)
  }

  /** The files of a new (or renamed) directory are added, and on Linux it is watched too. */
  async function enter(directory: string): Promise<void> {
    const directories: string[] = []
    const files = new Map<string, number>()
    await walk(directory, directories, files)
    if (perDirectory) for (const path of directories) open(path, false)
    for (const [path, mtime] of files) {
      const before = known.get(path)
      if (before === mtime) continue
      known.set(path, mtime)
      report({ kind: before === undefined ? 'add' : 'change', path, mtimeMs: mtime })
    }
  }

  /** Closes the watches at or under `directory`. */
  function closeUnder(directory: string): void {
    for (const [path, handle] of handles) {
      if (path === directory || path.startsWith(directory + sep)) {
        handle.close()
        handles.delete(path)
      }
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
      if (known.delete(path)) {
        report({ kind: 'unlink', path, mtimeMs: undefined })
        return
      }
      // A directory that went away takes its files with it.
      const prefix = path + sep
      for (const file of [...known.keys()]) {
        if (!file.startsWith(prefix)) continue
        known.delete(file)
        report({ kind: 'unlink', path: file, mtimeMs: undefined })
      }
      if (perDirectory) closeUnder(path)
      return
    }
    if (stat.isDirectory()) {
      if (!ignoresDirectory(path)) await enter(path)
      return
    }
    if (!stat.isFile() || !options.keeps(path)) return
    const before = known.get(path)
    known.set(path, stat.mtimeMs)
    report({ kind: before === undefined ? 'add' : 'change', path, mtimeMs: stat.mtimeMs })
  }

  /** A directory event that named no file: every entry is looked at again, and the ones gone. */
  async function rescan(directory: string): Promise<void> {
    let names: string[] = []
    try {
      names = await readdir(directory)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    const present = new Set(names.map((name) => join(directory, name)))
    for (const path of [...known.keys()]) {
      if (path.slice(0, path.lastIndexOf(sep)) === directory && !present.has(path)) {
        await look(path)
      }
    }
    for (const path of present) await look(path)
  }

  const directories: string[] = []
  for (const root of options.roots) await walk(root, directories, known)
  try {
    if (perDirectory) for (const directory of directories) open(directory, false)
    else for (const root of options.roots) open(root, true)
  } catch (error) {
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
