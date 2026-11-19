// Shared externals evaluated again per file (D127, P42, D132, B23f). Two keys turn it on, and
// either opens the windows below (`reevaluatesExternals`, `../reevaluation.ts`):
// - `ModulePolicy.reevaluateHookingExternals`: a load that reads (or writes) a per-file global,
//   one the file's setup installed (a test hook, `expect`, the environment's `document`);
// - `ModulePolicy.reevaluatePatchingExternals`: a load that adds or replaces a key of the global,
//   which the environment's restore takes away after the file (msw's interceptors).
// What a window counts is the worker's watcher's business; this file only opens the windows and
// keeps what they learn.
// A node_modules package loads natively once per worker, but Jest evaluates it again in every test
// file's registry, so whatever it did as it loaded (`afterEach(cleanup)`, `expect.extend`, a
// `screen` bound to the file's `document`, a `jest.fn` of the file's `jest`, a global key) is the
// file's own. The worker learns which externals do that: the loader marks the window of each
// external's first native load from a user module or the runner, and the worker's watcher says
// whether the load did either inside it. Such an external, with every node_modules file its load
// evaluated, is inlined (loaded through the registry) from the next file on, so its top-level code
// runs again for each file. Outside a window nothing is watched, so steady-state loads pay one `Set` lookup.
// What such an external imports, what imports it, and a dependency of one of those that only
// per-file files import (a registry a per-file plugin writes into), are evaluated per file too
// (D132): `settlePerFile` keeps that set over the part of the graph the worker knows.
import { createRequire } from 'node:module'
import type { ExternalLoadWatcher } from '@provino/types'
import { inGraph, packageDirOf } from '../graph/index.ts'

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
  /**
   * Externals with the verdict "shared": evaluated once through a file's registry under a window
   * that saw no per-file read or write (`watchedEvaluation`), a file such a one's static closure
   * reaches, one Node held already, or one an earlier run found so (`seedShared`). Loaded natively
   * from then on, unless the per-file set takes them. An external with no verdict at all (in no
   * set here) is evaluated through the registry, as a warm run and Jest evaluate it.
   */
  readonly shared: Set<string>
  /**
   * The shared externals this worker evaluated under a window that saw nothing: their native load
   * is not watched again. (A file only a closure walk or an earlier run made shared is.)
   */
  readonly quiet: Set<string>
  /** Whether `shared` grew since it was last written (`verdicts.ts`). */
  sharedGrew: boolean
  /** The externals the running file evaluates through its registry for their verdict. */
  readonly probing: Set<string>
  /** The probed files the open window evaluated, which take its verdict with it; `null` outside one. */
  windowFiles: string[] | null
  /** Whether an earlier run's verdicts were read (`verdicts.ts`, once per worker). */
  verdictsRead: boolean
}

/**
 * The part of the node_modules graph the worker knows (D132), and the set of files evaluated per
 * file that it makes: the edges of the static closure of every external the worker loaded from a
 * file or asked about at an edge, both ways, through the user modules a closure goes through
 * (workspace packages linked into `node_modules`). The seeds are the externals evaluated per file
 * for a reason of their own (`active`, D127 and D129; a file the transforms make a user module,
 * D130). The set is the seeds, every file of a seed's static closure (`joinClosure`), every file
 * that imports a file of the set (the reach rule), and the dependencies of the set that
 * `settlePerFile` lets join.
 *
 * The set only grows, and a file sees only what it stood at when the file's registry was created,
 * plus what reaches it since (`members`): what joins once the file has asked about an external
 * waits in `pending` for the next file (`promoteLearned`). So a file never holds a package's
 * native copy beside its own, and a package is never per file in one file and shared in the next.
 */
export interface PerFileGraph {
  /** Each indexed file's targets (files only, each once), set once per worker. */
  readonly edges: Map<string, readonly string[]>
  /** Each known target's importers, with how many of them are in the set and in the region. */
  readonly importers: Map<string, Importers>
  /**
   * The files evaluated per file in the file running now (`evaluatedPerFile` answers from it): the
   * externals, and the user modules a closure went through that are only loaded per file.
   */
  readonly members: Set<string>
  /** What joined once the running file had asked about an external: members from the next file. */
  readonly pending: Set<string>
  /**
   * The join's candidates: files a file of the set reaches downward that are not in it (and that
   * the loader could evaluate), each kept out so far by an importer outside the set.
   */
  readonly region: Set<string>
  /** Files evaluated in every file for another reason (a served module): never block a join. */
  readonly elsewhere: Set<string>
  /** By package name, the indexed files that scan as dynamic and could load that package. */
  readonly dynamicByName: Map<string, string[]>
  /** Each dynamic file's bound (the package names it could load), for when it joins the set. */
  readonly dynamic: Map<string, ReadonlySet<string>>
  /** Region files whose importers changed since the last settle: decided again then. */
  readonly probes: Set<string>
  /** Files a seed's closure walk has joined (`joinClosure`): each is walked once per worker. */
  readonly closed: Set<string>
  /** Whether the running file has asked about an external yet: what joins after that is pending. */
  answered: boolean
  /** How many of `active`, and of the claims' user modules, are in the set as seeds. */
  primedActive: number
  primedClaimed: number
}

/** A file's importers, and how many are in the set (or `elsewhere`) and in the region. */
export interface Importers {
  readonly files: string[]
  inSet: number
  inRegion: number
}

function createPerFileGraph(): PerFileGraph {
  return {
    edges: new Map(),
    importers: new Map(),
    members: new Set(),
    pending: new Set(),
    region: new Set(),
    elsewhere: new Set(),
    dynamicByName: new Map(),
    dynamic: new Map(),
    probes: new Set(),
    closed: new Set(),
    answered: false,
    primedActive: 0,
    primedClaimed: 0,
  }
}

/** What the set is made from besides the graph, built once per worker. */
export interface PerFileSources {
  /** The `node_modules` files the transforms made user modules, append-only (D130). */
  readonly claimed: readonly string[]
  /** The externals the worker has loaded natively so far (by path, or a builtin's `node:` id). */
  readonly loaded: ReadonlyMap<string, unknown>
  /** Whether a node_modules file can be evaluated per file at all (no addon or WebAssembly). */
  readonly keep: (path: string) => boolean
}

/** A join refused because a file that scans as dynamic (outside the set) could load `target`. */
export interface DynamicRefusal {
  readonly target: string
  readonly dynamic: string
}

const NO_TARGETS: readonly string[] = []
const NO_REFUSALS: readonly DynamicRefusal[] = []

function importersOf(graph: PerFileGraph, path: string): Importers {
  let importers = graph.importers.get(path)
  if (importers === undefined) {
    importers = { files: [], inSet: 0, inRegion: 0 }
    graph.importers.set(path, importers)
  }
  return importers
}

function inSet(graph: PerFileGraph, path: string): boolean {
  return graph.members.has(path) || graph.pending.has(path)
}

/** Whether the loader can evaluate `path` itself: a user module, or a `keep` node_modules file. */
function candidate(path: string, keep: (path: string) => boolean): boolean {
  return !inGraph(path) || keep(path)
}

/** The importers of `path` outside the set and the region: files that load it natively. */
function sharedImporters(graph: PerFileGraph, path: string): number {
  const importers = graph.importers.get(path)
  return importers === undefined ? 0 : importers.files.length - importers.inSet - importers.inRegion
}

/** The package a node_modules file belongs to, by name (`@scope/name`), or `null`. */
function packageNameOf(path: string): string | null {
  const dir = packageDirOf(path)
  return dir === null
    ? null
    : dir.slice(dir.lastIndexOf('/node_modules/') + '/node_modules/'.length)
}

/** Puts `path` and its downward closure outside the set into the region, each to be probed. */
function enterRegion(graph: PerFileGraph, path: string, keep: (path: string) => boolean): void {
  const stack = [path]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined || graph.region.has(current)) continue
    graph.region.add(current)
    graph.probes.add(current)
    // A file evaluated per file elsewhere is counted with the set already.
    const counted = graph.elsewhere.has(current)
    for (const target of graph.edges.get(current) ?? NO_TARGETS) {
      if (!counted) importersOf(graph, target).inRegion++
      graph.probes.add(target)
      if (!inSet(graph, target) && candidate(target, keep)) stack.push(target)
    }
  }
}

/**
 * Puts `path` in the set, with every file that imports it (the reach rule): in `members` when
 * `effective` (the running file may evaluate it per file now), else in `pending`. A pending file
 * that a member reaches is made a member. What it imports is a candidate from now on.
 */
function joinSet(
  graph: PerFileGraph,
  path: string,
  effective: boolean,
  keep: (path: string) => boolean,
): void {
  const stack: [string, boolean][] = [[path, effective]]
  while (stack.length > 0) {
    const next = stack.pop()
    if (next === undefined) break
    const [current, now] = next
    if (graph.members.has(current)) continue
    if (graph.pending.has(current)) {
      if (!now) continue
      // Pending until a member reached it: what imports it reaches a member too.
      graph.pending.delete(current)
      graph.members.add(current)
      for (const importer of graph.importers.get(current)?.files ?? NO_TARGETS) {
        stack.push([importer, true])
      }
      continue
    }
    ;(now ? graph.members : graph.pending).add(current)
    const fromRegion = graph.region.delete(current)
    const counted = graph.elsewhere.has(current)
    const bound = graph.dynamic.get(current)
    for (const target of graph.edges.get(current) ?? NO_TARGETS) {
      const importers = importersOf(graph, target)
      if (!counted) {
        if (fromRegion) importers.inRegion--
        importers.inSet++
      }
      if (inSet(graph, target)) continue
      if (!candidate(target, keep)) continue
      if (graph.region.has(target)) graph.probes.add(target)
      else enterRegion(graph, target, keep)
    }
    // A dynamic file in the set loads through the registry: what it bounded may join now.
    if (bound !== undefined) {
      for (const file of graph.region) {
        const name = packageNameOf(file)
        if (name !== null && bound.has(name)) graph.probes.add(file)
      }
    }
    for (const importer of graph.importers.get(current)?.files ?? NO_TARGETS) {
      stack.push([importer, now || !graph.answered])
    }
  }
}

/**
 * Puts every file of the seed `seed`'s static closure in the set (`joinSet`, so what imports any of
 * them follows by the reach rule), whatever else imports them. So the set a seed makes does not
 * depend on whether the worker saw a shared importer of its closure before the seed: a cold worker
 * that learns the seed in its first file and a warm one seeded with it from the results cache end
 * with the same set. Only the files the loader could evaluate are walked. A file that a dynamic file
 * outside the set and the closure could load natively stays out, with everything below it, as the
 * region's join drops them: they are left to it (`joinProbed`, which refuses them and says so). A
 * file joined here is never walked again in the worker.
 */
function joinClosure(
  graph: PerFileGraph,
  seed: string,
  now: boolean,
  keep: (path: string) => boolean,
): void {
  // The part of the closure no earlier walk joined.
  const area = new Set<string>()
  const stack = [seed]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined || area.has(current) || graph.closed.has(current)) continue
    if (current !== seed && !candidate(current, keep)) continue
    area.add(current)
    for (const target of graph.edges.get(current) ?? NO_TARGETS) stack.push(target)
  }
  for (const file of area) {
    if (file !== seed && dynamicLoaders(graph, file, area).length > 0) stack.push(file)
  }
  const blocked = new Set<string>()
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined || current === seed || blocked.has(current)) continue
    if (!area.has(current)) continue
    blocked.add(current)
    for (const target of graph.edges.get(current) ?? NO_TARGETS) stack.push(target)
  }
  for (const file of area) {
    if (blocked.has(file)) continue
    graph.closed.add(file)
    joinSet(graph, file, now, keep)
  }
}

/**
 * Puts `path`'s edges in the graph, once per worker. `dynamic` is the package names a file that
 * scans as dynamic could load (`null` for a file the scan reads whole), `elsewhere` whether the
 * file is evaluated in every file for another reason (so it never keeps a dependency shared).
 */
export function indexFile(
  graph: PerFileGraph,
  path: string,
  targets: readonly string[],
  dynamic: ReadonlySet<string> | null,
  elsewhere: boolean,
  keep: (path: string) => boolean,
): void {
  if (graph.edges.has(path)) return
  graph.edges.set(path, targets.length === 0 ? NO_TARGETS : targets)
  if (elsewhere) graph.elsewhere.add(path)
  if (dynamic !== null) {
    graph.dynamic.set(path, dynamic)
    for (const name of dynamic) {
      const files = graph.dynamicByName.get(name)
      if (files === undefined) graph.dynamicByName.set(name, [path])
      else files.push(path)
    }
  }
  const counted = inSet(graph, path) || elsewhere
  const below = inSet(graph, path) || graph.region.has(path)
  let reaches = false
  let reachesMember = false
  for (const target of targets) {
    const importers = importersOf(graph, target)
    importers.files.push(path)
    if (counted) importers.inSet++
    else if (graph.region.has(path)) importers.inRegion++
    if (graph.members.has(target)) reachesMember = true
    if (inSet(graph, target)) reaches = true
    else if (below && candidate(target, keep)) {
      if (graph.region.has(target)) graph.probes.add(target)
      else enterRegion(graph, target, keep)
    }
  }
  if (reaches && !inSet(graph, path)) joinSet(graph, path, reachesMember || !graph.answered, keep)
}

/** The dynamic files outside the set (and not in `within`) that could load `path` natively. */
function dynamicLoaders(
  graph: PerFileGraph,
  path: string,
  within: ReadonlySet<string>,
): readonly string[] {
  const name = packageNameOf(path)
  const files = name === null ? undefined : graph.dynamicByName.get(name)
  if (files === undefined) return NO_TARGETS
  return files.filter((file) => file !== path && !inSet(graph, file) && !within.has(file))
}

/**
 * Decides the probed region files: the greatest set of them (and of the region files they reach
 * whose every importer is in the set or the region) whose importers are all in the set or in it,
 * and joins it. A region file with an importer outside both (a shared package, or a dynamic file
 * outside the set that could load it, `dynamicLoaders`) is dropped, and so is what only reaches the
 * set through a dropped one. The rest joins: a cycle below a per-file package too, which no
 * least fixed point admits. Each settle touches only the probed files and what they reach, and an
 * edge between two files outside the set and the region probes nothing.
 */
function joinProbed(
  graph: PerFileGraph,
  keep: (path: string) => boolean,
  refusals: DynamicRefusal[],
): void {
  while (graph.probes.size > 0) {
    const area = new Set<string>()
    const stack: string[] = []
    for (const probe of graph.probes) {
      if (graph.region.has(probe) && sharedImporters(graph, probe) === 0) stack.push(probe)
    }
    graph.probes.clear()
    while (stack.length > 0) {
      const current = stack.pop()
      if (current === undefined || area.has(current)) continue
      area.add(current)
      for (const target of graph.edges.get(current) ?? NO_TARGETS) {
        if (graph.region.has(target) && sharedImporters(graph, target) === 0) stack.push(target)
      }
    }
    if (area.size === 0) return
    // Per file of the area: its importers outside the set and the area (in the region, dropped).
    const outside = new Map<string, number>()
    for (const file of area) outside.set(file, importersOf(graph, file).inRegion)
    for (const file of area) {
      for (const target of graph.edges.get(file) ?? NO_TARGETS) {
        const count = outside.get(target)
        if (count !== undefined) outside.set(target, count - 1)
      }
    }
    const dropped = new Set<string>()
    const drop: string[] = []
    for (const file of area) {
      const loaders = dynamicLoaders(graph, file, area)
      const first = loaders[0]
      if (first !== undefined) {
        if ((outside.get(file) ?? 0) === 0) refusals.push({ target: file, dynamic: first })
        outside.set(file, (outside.get(file) ?? 0) + loaders.length)
      }
      if ((outside.get(file) ?? 0) > 0) drop.push(file)
    }
    while (drop.length > 0) {
      const file = drop.pop()
      if (file === undefined || dropped.has(file)) continue
      dropped.add(file)
      for (const target of graph.edges.get(file) ?? NO_TARGETS) {
        if (!area.has(target) || dropped.has(target)) continue
        outside.set(target, (outside.get(target) ?? 0) + 1)
        drop.push(target)
      }
      const bound = graph.dynamic.get(file)
      if (bound === undefined) continue
      for (const target of area) {
        const name = packageNameOf(target)
        if (target !== file && !dropped.has(target) && name !== null && bound.has(name)) {
          refusals.push({ target, dynamic: file })
          drop.push(target)
        }
      }
    }
    for (const file of area) {
      if (!dropped.has(file)) joinSet(graph, file, !graph.answered, keep)
    }
  }
}

/**
 * Settles the set before `evaluatedPerFile` answers for `path`: when the seeds grew, indexes what
 * the worker loaded natively (so what an earlier file loaded follows by reach, and a dynamic file
 * among it is known) and the new seeds, and puts them in the set; indexes `path`; joins each new
 * seed's closure (`joinClosure`); then decides what the changes probed (`joinProbed`). `index`
 * indexes a file's closure (`indexClosure` in `inline.ts`). Returns the joins a dynamic file
 * refused, for the caller to report.
 */
export function settlePerFile(
  state: ReevaluateState,
  sources: PerFileSources,
  index: (path: string) => void,
  path: string,
): readonly DynamicRefusal[] {
  const graph = state.perFile
  const { active } = state
  const { claimed, keep } = sources
  let seeds: string[] | undefined
  if (graph.primedActive !== active.size || graph.primedClaimed !== claimed.length) {
    for (const loaded of sources.loaded.keys()) if (inGraph(loaded)) index(loaded)
    seeds = []
    let at = 0
    for (const seed of active) if (at++ >= graph.primedActive) seeds.push(seed)
    for (let next = graph.primedClaimed; next < claimed.length; next++) {
      const seed = claimed[next]
      if (seed !== undefined) seeds.push(seed)
    }
    for (const seed of seeds) {
      index(seed)
      joinSet(graph, seed, !graph.answered, keep)
    }
    graph.primedActive = active.size
    graph.primedClaimed = claimed.length
  }
  index(path)
  // Each new seed's closure, once every new seed is in the set and `path` is known: a dynamic file
  // either is (a seed, or `path`) can keep a file of a closure out.
  if (seeds !== undefined) for (const seed of seeds) joinClosure(graph, seed, !graph.answered, keep)
  if (graph.probes.size === 0) return NO_REFUSALS
  const refusals: DynamicRefusal[] = []
  joinProbed(graph, keep, refusals)
  return refusals.length === 0 ? NO_REFUSALS : refusals
}

/** Makes what joined while the last file ran a member: called as a file's registry is created. */
function promotePerFile(graph: PerFileGraph): void {
  graph.answered = false
  if (graph.pending.size === 0) return
  for (const path of graph.pending) graph.members.add(path)
  graph.pending.clear()
}

export function createReevaluateState(): ReevaluateState {
  return {
    active: new Set(),
    pending: new Set(),
    learned: [],
    watchers: new Set(),
    perFile: createPerFileGraph(),
    watching: false,
    shared: new Set(),
    quiet: new Set(),
    sharedGrew: false,
    probing: new Set(),
    windowFiles: null,
    verdictsRead: false,
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

/** Whether Node's own cache holds `path`: a native load (the loader's, or one outside it) made it. */
export function inNodeCache(path: string): boolean {
  return nativeCache[path] !== undefined
}

/** Whether the external at `path` has a verdict: per file (seeded or learned), or shared. */
export function hasVerdict(state: ReevaluateState, path: string): boolean {
  return state.active.has(path) || state.pending.has(path) || state.shared.has(path)
}

/**
 * Walks a file's static closure among node_modules files, the file first, going below a file only
 * when `enter` returns `true` for it (`inline.ts`'s `walkBelow`).
 */
export type WalkBelow = (path: string, enter: (file: string) => boolean) => void

/**
 * Gives `files`, and every file of their static closures with no verdict, the verdict "shared". A
 * walk stops at a file with a verdict (a shared one's closure is shared already). So a file a shared
 * package requires only later (inside a function a test calls) loads natively, as that package's
 * own `require` of it does, and never through a registry beside it. `evaluated`: `files` were
 * evaluated under a window that saw nothing (`quiet`).
 */
export function share(
  state: ReevaluateState,
  files: readonly string[],
  keep: (file: string) => boolean,
  below: WalkBelow,
  evaluated: boolean,
): void {
  for (const file of files) {
    if (evaluated && keep(file) && !hasVerdict(state, file)) state.quiet.add(file)
    below(file, (reached) => {
      if (!keep(reached) || hasVerdict(state, reached)) return false
      state.shared.add(reached)
      state.sharedGrew = true
      return true
    })
  }
}

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
  // Evaluated already under a window that saw nothing: its native load would see the same.
  if (state.quiet.has(path)) return load()
  return openWindow(state, path, load, keep, ownPackage, null)
}

/**
 * Runs `evaluate`, the first evaluation of the external at `path` through a file's registry while
 * it has no verdict (`ReevaluateState.probing`), as a watched window: the load a warm run makes of
 * it, with the environment's conditions and the file's mocks, rather than a native one. When a
 * watcher says a per-file global was read or written, `path` and every probed file the window
 * evaluated are learned as a native load's window learns (and so are its package's files and what
 * it loaded natively); when none was, they and their static closures are shared from the next
 * file on (`share`). Inside an open window it is part of that window. A window that saw nothing
 * because no watcher watched, or whose evaluation threw, gives no verdict: the next file asks
 * again.
 */
export function watchedEvaluation<T>(
  state: ReevaluateState,
  path: string,
  evaluate: () => T,
  keep: (file: string) => boolean,
  ownPackage: (file: string) => readonly string[],
  below: WalkBelow,
): T {
  if (state.watching) {
    state.windowFiles?.push(path)
    return evaluate()
  }
  return openWindow(state, path, evaluate, keep, ownPackage, below)
}

/**
 * An evaluation through a registry that no window can watch (an ES module that awaits: other loads
 * would run inside it): learned, so it is evaluated per file, as under Jest.
 */
export function learnUnwatched(state: ReevaluateState, path: string): void {
  if (state.shared.has(path)) return
  learn(state, path)
}

function openWindow<T>(
  state: ReevaluateState,
  path: string,
  load: () => T,
  keep: (file: string) => boolean,
  ownPackage: (file: string) => readonly string[],
  below: WalkBelow | null,
): T {
  if (state.watching || state.watchers.size === 0 || state.active.has(path)) return load()
  const ends: (() => boolean)[] = []
  /** Node's cache before the load: read only once a window is open, as only then can it learn. */
  let before: readonly string[] | undefined
  let loadFailed = false
  /** An evaluation window's probed files, `path` first. */
  const evaluated: string[] = [path]
  state.watching = true
  if (below !== null) state.windowFiles = evaluated
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
    state.windowFiles = null
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
      for (const file of evaluated) learn(state, file)
      for (const file of ownPackage(path)) if (keep(file)) learn(state, file)
      for (const file of Object.keys(nativeCache)) {
        if (!known.has(file) && keep(file)) learn(state, file)
      }
    } else if (below !== null && ends.length > 0 && failure === undefined && !loadFailed) {
      share(state, evaluated, keep, below, true)
    }
    // biome-ignore lint/correctness/noUnsafeFinally: an end that threw must not pass silently.
    if (failure !== undefined && !loadFailed) throw failure.error
  }
}

/**
 * Makes what the last file learned active, and what joined the per-file set while it ran a member:
 * called as a file's registry is created.
 */
export function promoteLearned(state: ReevaluateState): void {
  promotePerFile(state.perFile)
  // What the last file evaluated for its verdict has one now: no file asks again.
  state.probing.clear()
  if (state.pending.size === 0) return
  activate(state, state.pending)
  state.pending.clear()
}
