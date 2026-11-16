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
  /** What was learned since `takeLearned` last said so, in the order it was (never a seeded one). */
  readonly learned: string[]
  readonly watchers: Set<ExternalLoadWatcher>
  /** Which externals are evaluated per file, from the seeds and the known graph (D132). */
  readonly perFile: PerFileGraph
  /** Whether a watched load is running: a load inside it is part of it, never a window of its own. */
  watching: boolean
}

/**
 * The part of the node_modules graph the worker knows (D132): the edges of the static closure of
 * every external it loaded from a file or asked about at an edge, both ways, and the set of
 * externals evaluated per file that `selectPerFile` makes of it. The seeds are the externals
 * evaluated per file for a reason of their own (`active`, D127 and D129; a file the transforms
 * make a user module, D130).
 *
 * The set only grows: a file never holds two copies of a package because the worker learned more
 * of the graph halfway through it, and a package is never evaluated per file in one file and
 * shared in the next.
 */
export interface PerFileGraph {
  /** Each known target's importers (node_modules files, and user modules a closure went through). */
  readonly importers: Map<string, Set<string>>
  /** Each known importer's targets. */
  readonly imports: Map<string, Set<string>>
  /** The files whose edges are in the two maps. */
  readonly indexed: Set<string>
  /** The externals evaluated per file now. */
  members: ReadonlySet<string>
  /** Whether the graph or the seeds changed since `members` was settled. */
  stale: boolean
  /** How many of `active`, and of the claims' user modules, have been indexed as seeds. */
  primedActive: number
  primedClaimed: number
}

function createPerFileGraph(): PerFileGraph {
  return {
    importers: new Map(),
    imports: new Map(),
    indexed: new Set(),
    members: new Set(),
    stale: false,
    primedActive: 0,
    primedClaimed: 0,
  }
}

/** Records that `importer` has an edge to `target`. */
export function linkPerFile(graph: PerFileGraph, importer: string, target: string): void {
  let importers = graph.importers.get(target)
  if (importers === undefined) {
    importers = new Set()
    graph.importers.set(target, importers)
  }
  importers.add(importer)
  let imports = graph.imports.get(importer)
  if (imports === undefined) {
    imports = new Set()
    graph.imports.set(importer, imports)
  }
  imports.add(target)
}

const NO_IMPORTERS: ReadonlySet<string> = new Set()

/**
 * D132's rule for a dependency of a package evaluated per file: it is evaluated per file too only
 * when every importer the worker knows is. So a package the shared part of the graph imports
 * (`react` under a component library) stays shared, and nothing evaluated per file pulls a shared
 * package's dependencies along. The one place the rule is decided: `selectPerFile` takes it to a
 * fixed point.
 */
export function joinsPerFile(
  importers: ReadonlySet<string>,
  members: ReadonlySet<string>,
): boolean {
  for (const importer of importers) if (!members.has(importer)) return false
  return true
}

/**
 * The externals evaluated per file: the seeds (and `base`, what was evaluated per file before), everything that imports one of them, through any chain of known edges (the
 * reach rule, so a shared importer never loads Node's copy of what the file has its own of), and
 * every dependency `joinsPerFile` lets in, with what imports it, until nothing changes. `keep` says
 * which files can be evaluated per file at all (no addon, WebAssembly or builtin).
 */
export function selectPerFile(
  graph: PerFileGraph,
  seeds: Iterable<string>,
  keep: (path: string) => boolean,
  base: Iterable<string> = [],
): Set<string> {
  const members = new Set<string>()
  const added: string[] = []
  const add = (path: string): void => {
    const up = [path]
    while (up.length > 0) {
      const current = up.pop()
      if (current === undefined || members.has(current)) continue
      members.add(current)
      added.push(current)
      for (const importer of graph.importers.get(current) ?? NO_IMPORTERS) up.push(importer)
    }
  }
  for (const path of base) add(path)
  for (const path of seeds) add(path)
  while (added.length > 0) {
    const member = added.pop()
    if (member === undefined) break
    for (const target of graph.imports.get(member) ?? NO_IMPORTERS) {
      if (members.has(target) || !keep(target)) continue
      if (joinsPerFile(graph.importers.get(target) ?? NO_IMPORTERS, members)) add(target)
    }
  }
  return members
}

export function createReevaluateState(): ReevaluateState {
  return {
    active: new Set(),
    pending: new Set(),
    learned: [],
    watchers: new Set(),
    perFile: createPerFileGraph(),
    watching: false,
  }
}

/** Makes `paths` active (an earlier run's set); the per-file set sees them on its next question. */
export function activate(state: ReevaluateState, paths: Iterable<string>): void {
  for (const path of paths) state.active.add(path)
}

/** Learns `file`, unless it is evaluated per file already: pending, and one more for `takeLearned`. */
function learn(state: ReevaluateState, file: string): void {
  if (state.active.has(file) || state.pending.has(file)) return
  state.pending.add(file)
  state.learned.push(file)
}

const NOTHING_LEARNED: readonly string[] = []

/** What was learned since the last call (each file once, not a seeded one); no allocation for none. */
export function takeLearned(state: ReevaluateState): readonly string[] {
  return state.learned.length === 0 ? NOTHING_LEARNED : state.learned.splice(0)
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
      learn(state, path)
      for (const file of ownPackage(path)) if (keep(file)) learn(state, file)
      for (const file of Object.keys(nativeCache)) {
        if (!known.has(file) && keep(file)) learn(state, file)
      }
    }
    // biome-ignore lint/correctness/noUnsafeFinally: an end that threw must not pass silently.
    if (failure !== undefined && !loadFailed) throw failure.error
  }
}

/** Makes what the last file learned active: called as a file's registry is created. */
export function promoteLearned(state: ReevaluateState): void {
  if (state.pending.size === 0) return
  activate(state, state.pending)
  state.pending.clear()
}
