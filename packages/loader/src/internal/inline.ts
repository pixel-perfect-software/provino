// Mock-aware auto-inlining (T2.6, Track 2 R3, B13d): which node_modules files load per file,
// through that file's registry, so a mock reaches them. A shared external is loaded natively, so its
// own imports never meet the mock registry. When the dialect says a mock reaches the packages that
// import the mocked module (`ModulePolicy.mocksReachShared`), the loader asks, at the edge to an
// external, whether the external's graph closure holds an edge the file's mocks take: if so the
// external loads through the registry (inlined), and its own edges decide in turn.
//
// `decide()` stays the one authority on what a mock reaches (Gap 2): the closure's edges are put to
// it as they were written, with the specifier as written and the resolved id. It has no side effect
// that matters here: `decide` remembers a specifier for an id and, under automock-all, a deep
// unmock's imports, each of which the real edge would do on its own a moment later.
import type { LoaderOptions, LoaderWarning, ModuleId, ModuleMockRegistry } from '@provino/types'
import { conditionsOf } from '../graph/conditions.ts'
import {
  buildThirdPartyGraph,
  type GraphEdge,
  inGraph,
  packageDirOf,
  scanSource,
  type ThirdPartyGraph,
} from '../graph/index.ts'
import {
  linkPerFile,
  type PerFileGraph,
  type ReevaluateState,
  selectPerFile,
} from './reevaluate.ts'
import { readSource } from './source.ts'

/** The default for `LoaderOptions.inlineBudget`. */
export const DEFAULT_INLINE_BUDGET = 400

/**
 * What a file's mocks decided, per mocked-module registry: each node_modules path's verdict (the
 * id of the mocked module its closure reaches, or `null`), good for as long as the registry's
 * `generation()` holds.
 */
interface Verdicts {
  readonly generation: number
  readonly byPath: Map<string, string | null>
}

/** The worker-wide half of inlining: the graph, built on first use, and what was warned. */
export interface InlineState {
  /** Built on the first external that is asked about while mocks are active. */
  graph: ThirdPartyGraph | null
  /** The mocked ids whose budget warning went out, and the dynamic closures reported. */
  readonly warned: Set<string>
  /** The verdicts of each file's mocks; a registry that is gone takes its verdicts with it. */
  readonly verdicts: WeakMap<ModuleMockRegistry, Verdicts>
  /** Whether each node_modules path's closure reaches a module the dialect serves (`servedReach`). */
  readonly served: Map<string, boolean>
  /**
   * Whether each node_modules path's closure reaches a `node_modules` file the transforms make a
   * user module (`claimedReach`), kept for the worker and cleared when a `native` file becomes
   * `user`.
   */
  readonly claimed: Map<string, boolean>
}

export function createInlineState(): InlineState {
  return {
    graph: null,
    warned: new Set(),
    verdicts: new WeakMap(),
    served: new Map(),
    claimed: new Map(),
  }
}

/** What a file keeps about its inlining: for the budget and for `LeakReport.inlinedForMocks`. */
export interface InlineLedger {
  /** The modules inlined, per mocked id they reach. */
  readonly byMock: Map<string, Set<ModuleId>>
  /** Every module inlined, in the order they were. */
  readonly modules: Set<ModuleId>
}

export function createLedger(): InlineLedger {
  return { byMock: new Map(), modules: new Set() }
}

function warn(options: LoaderOptions, warning: LoaderWarning): void {
  if (options.onWarning !== undefined) {
    options.onWarning(warning)
    return
  }
  if (warning.level === 'debug') return
  process.emitWarning(warning.message, { code: warning.code })
}

/** Starts the graph on first use. */
function graphOf(state: InlineState, options: LoaderOptions): ThirdPartyGraph {
  state.graph ??= buildThirdPartyGraph({
    root: options.root,
    resolver: options.resolver,
    conditions: conditionsOf(options),
    cacheDir: options.graphCache ?? null,
    lockfileHash: options.lockfileHash ?? null,
  })
  return state.graph
}

/** Writes what the graph scanned to its cache; the worker does this once, when its loader ends. */
export function saveGraph(state: InlineState): void {
  state.graph?.save()
}

/**
 * The edges of a user module as the loader holds them, or `null` when it can't say (the file does
 * not compile). A closure that reaches one (a workspace package linked into `node_modules`) goes on
 * through it, since the graph covers real files under `node_modules` only.
 */
export type UserEdges = (path: string) => readonly GraphEdge[] | null

function verdictsOf(state: InlineState, mocks: ModuleMockRegistry): Verdicts {
  const generation = mocks.generation()
  let verdicts = state.verdicts.get(mocks)
  if (verdicts === undefined || verdicts.generation !== generation) {
    verdicts = { generation, byPath: new Map() }
    state.verdicts.set(mocks, verdicts)
  }
  return verdicts
}

/** What a closure walk found: the first edge `takes` named, the paths it covered, and whether one was dynamic. */
interface Walk {
  readonly found: string | null
  readonly done: ReadonlySet<string>
  readonly dynamic: boolean
}

/**
 * Walks `path`'s closure, through node_modules files (the graph) and the user modules an edge leads
 * to (`userEdges`), until `takes` names an edge.
 */
function walkClosure(
  state: InlineState,
  options: LoaderOptions,
  path: string,
  takes: (edge: GraphEdge, importer: string) => string | null,
  userEdges: UserEdges,
): Walk {
  const graph = graphOf(state, options)
  const done = new Set<string>()
  const stack = [path]
  let dynamic = false
  let found: string | null = null
  while (found === null && stack.length > 0) {
    const current = stack.pop()
    if (current === undefined || done.has(current)) continue
    done.add(current)
    if (inGraph(current)) {
      const closure = graph.edgesOf(current)
      for (const member of closure.paths) done.add(member)
      if (closure.dynamic) dynamic = true
      for (const { importer, edge } of closure.edges) {
        found = takes(edge, importer)
        if (found !== null) break
        // An edge out of node_modules that `takes` passes is a user module the loader can read.
        if (edge.target !== null && !edge.target.startsWith('node:') && !inGraph(edge.target)) {
          stack.push(edge.target)
        }
      }
    } else {
      const edges = userEdges(current)
      if (edges === null) {
        dynamic = true
        continue
      }
      for (const edge of edges) {
        found = takes(edge, current)
        if (found !== null) break
        if (edge.target !== null && !edge.target.startsWith('node:')) stack.push(edge.target)
      }
    }
  }
  return { found, done, dynamic }
}

/**
 * The first id among the edges `path` reaches that `mocks` takes, or `null` when none is. `path` is
 * a real file under `node_modules`; the graph is extended to its closure first. The walk goes on
 * through a user module an edge leads to (`userEdges`) and through the node_modules files it leads
 * back to. The verdict is kept until the mocks change, and a negative one holds for every
 * node_modules file the walk covered, since each reaches no more than `path` does.
 */
export function mockedReach(
  state: InlineState,
  options: LoaderOptions,
  path: string,
  mocks: ModuleMockRegistry,
  userEdges: UserEdges,
): string | null {
  const verdicts = verdictsOf(state, mocks)
  const known = verdicts.byPath.get(path)
  if (known !== undefined) return known
  const asked = new Set<string>()

  /** The mocked id an edge reaches, or `null`. */
  const takes = (edge: GraphEdge, importer: string): string | null => {
    const style = edge.kind === 'require' ? 'cjs' : 'esm'
    const key = `${style}\0${edge.target ?? ''}\0${edge.specifier}`
    if (asked.has(key)) return null
    asked.add(key)
    if (edge.target === null) {
      try {
        if (mocks.decideUnresolved(edge.specifier, importer).mocked) return edge.specifier
      } catch {
        // A mock that can't stand in (Vitest's relative path) is the edge's own error to raise.
      }
      return null
    }
    const decision = mocks.decide(
      edge.target,
      importer,
      edge.target.startsWith('node:') ? 'builtin' : style,
      edge.specifier,
    )
    return decision.mocked ? decision.id : null
  }

  const { found, done, dynamic } = walkClosure(state, options, path, takes, userEdges)
  if (found !== null) {
    verdicts.byPath.set(path, found)
    return found
  }
  for (const member of done) if (inGraph(member)) verdicts.byPath.set(member, null)
  // A computed `require` in a shared closure is an edge the graph can't see: a miss, if one was due.
  if (dynamic && !state.warned.has(path)) {
    state.warned.add(path)
    warn(options, {
      code: 'PROVINO_INLINE_DYNAMIC',
      level: 'debug',
      message: `${path} (or a module it loads) has a require the graph can't follow (a computed or aliased specifier, createRequire, or a file that could not be read or parsed), so a mock may not reach what it loads.`,
    })
  }
  return null
}

/**
 * `path`'s verdict in `known`, or the closure walk's: true when `direct` (a check of the file
 * itself, made before any walk) holds or `takes` names an edge of its closure. A positive verdict
 * is kept for `path`, and a negative one for every node_modules file the walk covered, since each
 * reaches no more than `path` does.
 */
function cachedReach(
  known: Map<string, boolean>,
  state: InlineState,
  options: LoaderOptions,
  path: string,
  takes: (edge: GraphEdge) => string | null,
  userEdges: UserEdges,
  direct?: () => boolean,
): boolean {
  const cached = known.get(path)
  if (cached !== undefined) return cached
  if (direct?.() === true) {
    known.set(path, true)
    return true
  }
  const { found, done } = walkClosure(state, options, path, takes, userEdges)
  if (found !== null) {
    known.set(path, true)
    return true
  }
  for (const member of done) if (inGraph(member)) known.set(member, false)
  return false
}

/**
 * Whether `path`'s closure has an edge to a module the dialect serves (`ModuleScope.modules`, such
 * as `@jest/globals`). Loaded natively, such a package would reach the real module (whose own code
 * may refuse to load outside its runner), so it is inlined, and its edge gets the served module, as
 * a user file's does. Kept per worker; a negative verdict holds for every node_modules file the
 * walk covered.
 *
 * The external's own edges are read first: one that requests a served module itself is inlined
 * without building its closure (`requestsDirectly`). Only otherwise is the closure walked (on a
 * cold graph, about 0.15 s for jsdom's closure, `local`; read from the graph cache on later runs).
 *
 * Limit: a request the scan can't read (a computed `require(name)` or `import(name)`, the closure's
 * `dynamic` flag) is not seen, so a package that reaches a served module only that way stays shared
 * and meets the real module.
 */
export function servedReach(
  state: InlineState,
  options: LoaderOptions,
  path: string,
  served: readonly string[],
  userEdges: UserEdges,
): boolean {
  return cachedReach(
    state.served,
    state,
    options,
    path,
    (edge) => (served.includes(edge.specifier) ? edge.specifier : null),
    userEdges,
    () => requestsDirectly(state, path, served),
  )
}

/**
 * Whether `path`'s closure has an edge whose resolved target `reaches` names, with the verdict kept
 * in `known` (`cachedReach`).
 */
function reachesTarget(
  known: Map<string, boolean>,
  state: InlineState,
  options: LoaderOptions,
  path: string,
  reaches: (target: string) => boolean,
  userEdges: UserEdges,
): boolean {
  return cachedReach(
    known,
    state,
    options,
    path,
    (edge) => (edge.target !== null && reaches(edge.target) ? edge.target : null),
    userEdges,
  )
}

/**
 * Puts the edges of `path`'s static closure into `perFile` (each file once per worker), through
 * the node_modules files the graph holds and the user modules an edge leads to (`userEdges`), and
 * says whether anything was new. A file's own edges are read from its graph node, not from the
 * closure's deduplicated list, which names only the first importer of each request.
 */
function indexClosure(
  state: InlineState,
  options: LoaderOptions,
  perFile: PerFileGraph,
  path: string,
  userEdges: UserEdges,
): boolean {
  if (perFile.indexed.has(path)) return false
  const graph = graphOf(state, options)
  const stack = [path]
  const follow = (importer: string, edges: readonly GraphEdge[]): void => {
    for (const { target } of edges) {
      if (target === null || target.startsWith('node:')) continue
      linkPerFile(perFile, importer, target)
      if (!inGraph(target)) stack.push(target)
    }
  }
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined || perFile.indexed.has(current)) continue
    if (!inGraph(current)) {
      perFile.indexed.add(current)
      follow(current, userEdges(current) ?? [])
      continue
    }
    for (const member of graph.edgesOf(current).paths) {
      if (perFile.indexed.has(member)) continue
      perFile.indexed.add(member)
      follow(member, graph.nodeOf(member)?.edges ?? [])
    }
    perFile.indexed.add(current)
  }
  return true
}

/** What the per-file set is made from, besides the graph: the claimed seeds and what the worker loaded. */
export interface PerFileSources {
  /** The `node_modules` files the transforms made user modules, in the order they were found (D130). */
  readonly claimed: readonly string[]
  /** The externals the worker has loaded natively so far (by path, or a builtin's `node:` id). */
  readonly loaded: Iterable<string>
  /** Whether a file can be evaluated per file at all (a node_modules file, no addon or WebAssembly). */
  readonly keep: (path: string) => boolean
}

/**
 * Whether the external at `path` is evaluated per file (D127, D129, D132): it is a seed (`active`,
 * or a claimed user module), it imports one through any chain of edges (so it shares the file's
 * copy, never Node's cached one: a component library over a learned `react`, an "Invalid hook
 * call"), or it is a dependency of such a package that only such packages import (`joinsPerFile`:
 * a registry a per-file package writes into as it loads, which would otherwise keep the first
 * file's entries).
 *
 * The graph it decides over is the closures of what the worker loaded natively (indexed whenever
 * the seeds grow, so a shared importer an earlier file loaded counts) and of every external an
 * edge asks about since. It is settled again only when the graph or the seeds grew, and it only
 * grows: a package once evaluated per file stays so, and a shared importer of it seen later
 * reaches it, so is inlined too, keeping one copy in a file. Once the graph is known, a question
 * costs a `Set` lookup.
 */
export function perFileReach(
  state: InlineState,
  options: LoaderOptions,
  path: string,
  reevaluate: ReevaluateState,
  sources: PerFileSources,
  userEdges: UserEdges,
): boolean {
  const { perFile, active } = reevaluate
  const { claimed } = sources
  if (perFile.primedActive !== active.size || perFile.primedClaimed !== claimed.length) {
    for (const loaded of sources.loaded) {
      if (inGraph(loaded)) indexClosure(state, options, perFile, loaded, userEdges)
    }
    for (const seed of active) indexClosure(state, options, perFile, seed, userEdges)
    for (const seed of claimed) indexClosure(state, options, perFile, seed, userEdges)
    perFile.primedActive = active.size
    perFile.primedClaimed = claimed.length
    perFile.stale = true
  }
  if (indexClosure(state, options, perFile, path, userEdges)) perFile.stale = true
  if (perFile.stale) {
    // The set only grows: what was evaluated per file stays so, in this file and the next.
    perFile.members = selectPerFile(perFile, [...active, ...claimed], sources.keep, perFile.members)
    perFile.stale = false
  }
  return perFile.members.has(path)
}

/**
 * Whether `path`'s static closure has an edge to a `node_modules` file the project's transforms
 * make a user module (`claimed`, B23e, D115). Loaded natively, such an external would `require`
 * Node's own copy of that file while the file's code gets its per-file one (two instances), or fail
 * on what only the transform resolves (an extensionless import). So it is inlined too. The verdict
 * is kept in `InlineState.claimed`, which is cleared when a claimed file becomes a user module
 * after Node failed to parse it.
 */
export function claimedReach(
  state: InlineState,
  options: LoaderOptions,
  path: string,
  claimed: (path: string) => boolean,
  userEdges: UserEdges,
): boolean {
  return reachesTarget(state.claimed, state, options, path, claimed, userEdges)
}

/**
 * Whether the file at `path` itself requests one of `served`: its edges when the graph (if one was
 * built) already holds them, else its text (a cheap test first, then the scan).
 */
function requestsDirectly(state: InlineState, path: string, served: readonly string[]): boolean {
  const node = state.graph?.nodeOf(path)
  if (node !== undefined) return node.edges.some((edge) => served.includes(edge.specifier))
  const source = readSource(path)
  if (source === undefined) return false
  if (!served.some((specifier) => source.includes(specifier))) return false
  return scanSource(source).edges.some((edge) => served.includes(edge.specifier))
}

/**
 * Records that `path` was inlined for the mocked module `mockedId`, and warns once per mocked id
 * and worker when more than the budget load for it in one file. It still inlines.
 */
export function noteInlined(
  state: InlineState,
  options: LoaderOptions,
  ledger: InlineLedger,
  path: ModuleId,
  mockedId: string,
): void {
  ledger.modules.add(path)
  let modules = ledger.byMock.get(mockedId)
  if (modules === undefined) {
    modules = new Set()
    ledger.byMock.set(mockedId, modules)
  }
  modules.add(path)
  const budget = options.inlineBudget ?? DEFAULT_INLINE_BUDGET
  if (modules.size > budget && !state.warned.has(`budget\0${mockedId}`)) {
    state.warned.add(`budget\0${mockedId}`)
    warn(options, {
      code: 'PROVINO_INLINE_BUDGET',
      level: 'warn',
      message: `Mocking ${mockedId} loads ${modules.size} modules per test file (the budget is ${budget}). They still load per file; mock a module nearer to your code to avoid this cost.`,
    })
  }
}

/**
 * The files of `path`'s own package that its static closure reaches (`path` among them). An
 * external evaluated per file takes them along (D127): Node's module cache shows what a CommonJS
 * load evaluated, but not the ES modules a `require(esm)` evaluated, and a package split between a
 * per-file entry and shared internals would be two half copies of itself.
 */
export function packageClosure(
  state: InlineState,
  options: LoaderOptions,
  path: string,
): readonly string[] {
  const own = packageDirOf(path)
  if (own === null) return []
  return graphOf(state, options)
    .edgesOf(path)
    .paths.filter((member) => packageDirOf(member) === own)
}
