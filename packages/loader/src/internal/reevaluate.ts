// Shared externals evaluated again per file (D127, P42; `ModulePolicy.reevaluateHookingExternals`).
// A node_modules package loads natively once per worker, but Jest evaluates it again in every test
// file's registry, so whatever it did as it loaded (`afterEach(cleanup)`, `expect.extend`, a
// `screen` bound to the file's `document`, a `jest.fn` of the file's `jest`) is the file's own. The
// worker learns which externals do that: the loader marks the window of each external's first
// native load from a user module or the runner, and the worker's watcher says whether a per-file
// global was read inside it. Such an external, with every node_modules file its load evaluated,
// is inlined (loaded through the registry) from the next file on, so its top-level code runs again
// for each file. Outside a window nothing is watched, so steady-state loads pay one `Set` lookup.
import { createRequire } from 'node:module'
import type { ExternalLoadWatcher } from '@provino/types'

/** What a worker knows about the externals it evaluates per file. */
export interface ReevaluateState {
  /** The node_modules files inlined for every file from now on. */
  readonly active: Set<string>
  /** Learned while the file running now loaded them: active from the next file on. */
  readonly pending: Set<string>
  readonly watchers: Set<ExternalLoadWatcher>
  /** Whether a watched load is running: a load inside it is part of it, never a window of its own. */
  watching: boolean
}

export function createReevaluateState(): ReevaluateState {
  return { active: new Set(), pending: new Set(), watchers: new Set(), watching: false }
}

/** Node's own module cache: what a native `require` adds an entry to, in load order. */
const nativeCache: NodeJS.Require['cache'] = createRequire(import.meta.url).cache

/**
 * Runs `load`, the first native load of the external at `path`, as a watched window when anyone
 * watches and no window is open. When a watcher says a per-file global was read, `path`, the files
 * of its own package its static closure reaches (`ownPackage`: an ES module a `require(esm)`
 * evaluated is not in Node's cache) and every file the load added to Node's cache are learned,
 * each that `keep` accepts (a node_modules file the loader could evaluate itself), active from the
 * next file on. A load that throws after such a read is learned too: the next file evaluates it
 * (and meets its error) through its registry, as Jest's would, instead of watching it again.
 *
 * Every window a watcher opened is closed, whatever throws: a watcher that throws as it opens (the
 * load is then not run, and its error is thrown), the load, or another window's end (each end is
 * called; the first end's error is thrown after the load's result is known, unless the load threw).
 */
export function watchedLoad<T>(
  state: ReevaluateState,
  path: string,
  load: () => T,
  keep: (file: string) => boolean,
  ownPackage: (file: string) => readonly string[],
): T {
  if (state.watching || state.watchers.size === 0 || state.active.has(path)) return load()
  const ends: (() => boolean)[] = []
  /** Node's cache before the load: read only once a window is open, as only then can it learn. */
  let before: readonly string[] | undefined
  let loadFailed = false
  state.watching = true
  try {
    for (const watcher of state.watchers) {
      const end = watcher(path)
      if (end !== null) ends.push(end)
    }
    if (ends.length > 0) before = Object.keys(nativeCache)
    try {
      return load()
    } catch (error) {
      loadFailed = true
      throw error
    }
  } finally {
    state.watching = false
    let perFile = false
    let failure: { readonly error: unknown } | undefined
    for (const end of ends) {
      try {
        if (end()) perFile = true
      } catch (error) {
        failure ??= { error }
      }
    }
    if (perFile && before !== undefined) {
      const known = new Set(before)
      state.pending.add(path)
      for (const file of ownPackage(path)) if (keep(file)) state.pending.add(file)
      for (const file of Object.keys(nativeCache)) {
        if (!known.has(file) && keep(file)) state.pending.add(file)
      }
    }
    // biome-ignore lint/correctness/noUnsafeFinally: an end that threw must not pass silently.
    if (failure !== undefined && !loadFailed) throw failure.error
  }
}

/** Makes what the last file learned active: called as a file's registry is created. */
export function promoteLearned(state: ReevaluateState): void {
  if (state.pending.size === 0) return
  for (const path of state.pending) state.active.add(path)
  state.pending.clear()
}
