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
import { readFileSync } from 'node:fs'
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
  indexFile,
  type PerFileSources,
  type ReevaluateState,
  settlePerFile,
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
  /** Per package directory, the package names a file of it that scans as dynamic could load (D132). */
  readonly declared: Map<string, ReadonlySet<string>>
  /**
   * Whether each node_modules path's closure has an edge Node would resolve to another file than
   * the loader does (`conditionalReach`), kept for the worker.
   */
  readonly conditional: Map<string, boolean>
  /** Per package directory, whether its `exports` or `imports` name a diverging condition. */
  readonly conditioned: Map<string, boolean>
}

export function createInlineState(): InlineState {
  return {
    graph: null,
    warned: new Set(),
    verdicts: new WeakMap(),
    served: new Map(),
    claimed: new Map(),
    declared: new Map(),
    conditional: new Map(),
    conditioned: new Map(),
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

const NO_EDGES: readonly GraphEdge[] = []

/** Whether an edge's resolved target is a file: not a builtin (`node:`), and resolved. */
function isFileTarget(target: string | null): target is string {
  return target !== null && !target.startsWith('node:')
}

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
 * What a walk already knows of a node_modules file it meets (not its start): a string ends the walk
 * with that as what it found, `null` leaves the file's closure out (it holds nothing `takes` names),
 * `undefined` walks it.
 */
type KnownReach = (path: string) => string | null | undefined

/**
 * Walks `path`'s closure until `takes` names an edge, node by node, so a walk that finds one early
 * costs the files visited before it, not the whole closure (a component library's file reaches
 * thousands). The node_modules files go depth first through the graph (`ThirdPartyGraph.visitNode`)
 * in the order `ThirdPartyGraph.reachable` lists them: each edge is put to `takes` as the file is
 * visited, and its target pushed as written. A user module an edge leads out to (a workspace package
 * linked into `node_modules`) waits on its own stack, and is walked (`userEdges`) once the graph
 * walk that found it ends, with the node_modules files it leads back to. So the first edge `takes`
 * names is the one a walk over the whole closure's edges names first. `known` (`KnownReach`)
 * shortens the walk with verdicts kept from earlier walks.
 */
function walkClosure(
  state: InlineState,
  options: LoaderOptions,
  path: string,
  takes: (edge: GraphEdge, importer: string) => string | null,
  userEdges: UserEdges,
  known?: KnownReach,
): Walk {
  const graph = graphOf(state, options)
  const done = new Set<string>()
  const users = [path]
  let dynamic = false
  let found: string | null = null
  while (found === null && users.length > 0) {
    const start = users.pop()
    if (start === undefined || done.has(start)) continue
    if (!inGraph(start)) {
      done.add(start)
      const edges = userEdges(start)
      if (edges === null) {
        dynamic = true
        continue
      }
      for (const edge of edges) {
        found = takes(edge, start)
        if (found !== null) break
        if (isFileTarget(edge.target) && !done.has(edge.target)) users.push(edge.target)
      }
      continue
    }
    const files = [start]
    while (found === null && files.length > 0) {
      const current = files.pop()
      if (current === undefined || done.has(current)) continue
      done.add(current)
      const verdict = current === path ? undefined : known?.(current)
      if (verdict === null) continue
      if (verdict !== undefined) {
        found = verdict
        break
      }
      const node = graph.visitNode(current)
      if (node === undefined) continue
      if (node.dynamic) dynamic = true
      for (const edge of node.edges) {
        found = takes(edge, current)
        if (found !== null) break
        if (!isFileTarget(edge.target) || done.has(edge.target)) continue
        // An edge out of node_modules that `takes` passes is a user module the loader can read.
        if (inGraph(edge.target)) files.push(edge.target)
        else users.push(edge.target)
      }
    }
  }
  return { found, done, dynamic }
}

/**
 * The first id among the edges `path` reaches that `mocks` takes, or `null` when none is. `path` is
 * a real file under `node_modules`; the walk (`walkClosure`) ends at that edge. It goes on
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
 * `path`'s verdict in `known`, or a walk's: true when `direct` (a check of the file itself, made
 * before any walk) holds or `takes` names an edge of its closure. A positive verdict is kept for
 * `path`, and a negative one for every node_modules file the walk covered, since each reaches no
 * more than `path` does. The walk (`walkClosure`) stops at the first edge `takes` names, and at a
 * file with a verdict in `known` already: a positive one ends it, a negative one has nothing to add.
 * The verdict is the same as a walk over the whole closure's edges: it is whether any edge of the
 * same reachable set is one `takes` names.
 */
function cachedReach(
  known: Map<string, boolean>,
  state: InlineState,
  options: LoaderOptions,
  path: string,
  takes: (edge: GraphEdge, importer: string) => string | null,
  userEdges: UserEdges,
  direct?: () => boolean,
): boolean {
  const cached = known.get(path)
  if (cached !== undefined) return cached
  if (direct?.() === true) {
    known.set(path, true)
    return true
  }
  const { found, done } = walkClosure(state, options, path, takes, userEdges, (file) => {
    const verdict = known.get(file)
    return verdict === undefined ? undefined : verdict ? file : null
  })
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
 * cold graph, about 170 ms for jsdom's 1,107 files, `local`; read from the graph cache on later
 * runs).
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

/** The distinct targets of `edges` that are files (no builtin, nothing unresolved). */
function fileTargets(edges: readonly GraphEdge[]): readonly string[] {
  const targets: string[] = []
  for (const { target } of edges) {
    if (isFileTarget(target) && !targets.includes(target)) targets.push(target)
  }
  return targets
}

/**
 * The package names a file that scans as dynamic could load natively: its own package's, and the
 * ones its `package.json` declares (`dependencies`, `optionalDependencies`, `peerDependencies`).
 * A computed `require(name)` resolves from the file's own directory, and a strict layout (pnpm's)
 * finds only these there; a hoisted one finds more, but a package that loads one it does not
 * declare is broken under pnpm already. The package directories its static closure reaches would be
 * no bound at all: a computed `require` is how a package loads what it does not import statically.
 * Kept per package directory; `null` outside one (a user module, which the registry loads anyway).
 */
function dynamicBound(state: InlineState, path: string): ReadonlySet<string> | null {
  const dir = packageDirOf(path)
  if (dir === null) return null
  const known = state.declared.get(dir)
  if (known !== undefined) return known
  const names = new Set<string>([dir.slice(dir.lastIndexOf('/node_modules/') + 14)])
  try {
    const manifest: unknown = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'))
    if (typeof manifest === 'object' && manifest !== null) {
      for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        const declared: unknown = Reflect.get(manifest, key)
        if (typeof declared === 'object' && declared !== null) {
          for (const name of Object.keys(declared)) names.add(name)
        }
      }
    }
  } catch {
    // No readable manifest: the package's own files are the bound.
  }
  state.declared.set(dir, names)
  return names
}

/**
 * Puts the edges of `path`'s static closure into the per-file graph (each file once per worker),
 * through the node_modules files the graph holds and the user modules an edge leads to
 * (`userEdges`). A file's own edges are read from its graph node, not from the closure's
 * deduplicated list, which names only the first importer of each request. `elsewhere` says which
 * files are evaluated per file for another reason (a served module), `null` when none can be.
 *
 * The walk goes node by node (`ThirdPartyGraph.visitNode`) and does not descend into a file that is
 * indexed already: every walk indexes a whole closure, so that file's closure is indexed too. A
 * walk from an external whose closure is mostly known (a component beside the ones a file loaded
 * before it) costs the files that are new, not the whole closure each time.
 */
function indexClosure(
  state: InlineState,
  options: LoaderOptions,
  reevaluate: ReevaluateState,
  sources: InlinePerFileSources,
  path: string,
): void {
  const perFile = reevaluate.perFile
  if (perFile.edges.has(path)) return
  const graph = graphOf(state, options)
  const { keep, userEdges, elsewhere } = sources
  const stack = [path]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined || perFile.edges.has(current)) continue
    let targets: readonly string[]
    if (inGraph(current)) {
      const node = graph.visitNode(current)
      if (node === undefined) continue
      targets = fileTargets(node.edges)
      const bound = node.dynamic ? dynamicBound(state, current) : null
      indexFile(perFile, current, targets, bound, elsewhere?.(current) ?? false, keep)
    } else {
      targets = fileTargets(userEdges(current) ?? NO_EDGES)
      indexFile(perFile, current, targets, null, elsewhere?.(current) ?? false, keep)
    }
    for (const target of targets) if (!perFile.edges.has(target)) stack.push(target)
  }
}

/** What `evaluatedPerFile` reads besides the graph, built once per worker. */
export interface InlinePerFileSources extends PerFileSources {
  readonly userEdges: UserEdges
  /** Whether a file is inlined in every file for another reason (`servedReach`); `null`: none. */
  readonly elsewhere: ((path: string) => boolean) | null
}

/**
 * Whether the external at `path` is evaluated per file in the running file (D127, D129, D132): it
 * is a seed (`active`, or a claimed user module), it imports a member through any chain of edges
 * (so it shares the file's copy, never Node's cached one: a component library over a learned
 * `react`, an "Invalid hook call"), or it is a dependency of members that only files evaluated per
 * file import (a registry a per-file package writes into as it loads, which would otherwise keep
 * the first file's entries). `settlePerFile` keeps the set; a join this file can't take yet
 * (it asked about an external already) is the next file's. A join a dynamic file refused is
 * reported once as `PROVINO_INLINE_DYNAMIC`. Once the graph is known, a question costs a lookup.
 */
export function evaluatedPerFile(
  state: InlineState,
  options: LoaderOptions,
  path: string,
  reevaluate: ReevaluateState,
  sources: InlinePerFileSources,
): boolean {
  const refusals = settlePerFile(
    reevaluate,
    sources,
    (file) => indexClosure(state, options, reevaluate, sources, file),
    path,
  )
  for (const { target, dynamic } of refusals) {
    const key = `per-file\0${target}`
    if (state.warned.has(key)) continue
    state.warned.add(key)
    warn(options, {
      code: 'PROVINO_INLINE_DYNAMIC',
      level: 'debug',
      message: `${dynamic} has a require the graph can't follow, and could load ${target} with it, so ${target} stays shared: evaluated per file, it would be a second copy beside the one ${dynamic} loads natively.`,
    })
  }
  return reevaluate.perFile.members.has(path)
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

/** The conditions a native load's own requests resolve with: Node's, the loader's default. */
const NATIVE_CONDITIONS: readonly string[] = conditionsOf({})

/**
 * The conditions that tell the loader's resolution from Node's: those it resolves with and Node
 * does not, and Node's that it lacks (`browser` and `node` under a DOM environment's
 * `['browser']`), or `null` when it resolves as Node does (the node environment).
 */
export function divergingConditions(options: {
  readonly conditions?: readonly string[] | undefined
}): ReadonlySet<string> | null {
  const own = conditionsOf(options)
  const diverging = new Set<string>()
  for (const condition of own) if (!NATIVE_CONDITIONS.includes(condition)) diverging.add(condition)
  for (const condition of NATIVE_CONDITIONS) if (!own.includes(condition)) diverging.add(condition)
  return diverging.size === 0 ? null : diverging
}

/** Whether `map` (an `exports` or `imports` value) names one of `conditions`, at any depth. */
function namesCondition(map: unknown, conditions: ReadonlySet<string>): boolean {
  if (map === null || typeof map !== 'object') return false
  for (const [key, value] of Object.entries(map)) {
    if (conditions.has(key) || namesCondition(value, conditions)) return true
  }
  return false
}

/** Whether the package at `dir`'s `exports` or `imports` names one of `diverging`; kept per directory. */
function conditionedPackage(
  state: InlineState,
  dir: string,
  diverging: ReadonlySet<string>,
): boolean {
  const known = state.conditioned.get(dir)
  if (known !== undefined) return known
  let names = false
  try {
    const manifest: unknown = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'))
    if (typeof manifest === 'object' && manifest !== null) {
      names =
        namesCondition(Reflect.get(manifest, 'exports'), diverging) ||
        namesCondition(Reflect.get(manifest, 'imports'), diverging)
    }
  } catch {
    // No readable manifest: no map, so the conditions choose nothing.
  }
  state.conditioned.set(dir, names)
  return names
}

/** A specifier that resolves through a manifest's map (a package, or a `#` import), not a path or a URL. */
const MAPPED_SPECIFIER = /^(?!\.{1,2}(?:\/|$)|\/|[a-z][a-z\d+.-]*:)/i

/**
 * Whether Node, loading `importer` natively, would resolve `edge` to another file than the loader
 * did (or to none). Only a specifier a manifest maps can differ by condition, and only through a
 * map that names a diverging condition: the target's package (and, for a `#` import, the
 * importer's), read once each. Only such an edge is resolved again, with Node's conditions.
 */
function resolvesElsewhere(
  state: InlineState,
  options: LoaderOptions,
  edge: GraphEdge,
  importer: string,
  diverging: ReadonlySet<string>,
): boolean {
  const { specifier, kind, target } = edge
  if (!isFileTarget(target) || !MAPPED_SPECIFIER.test(specifier)) return false
  const own = packageDirOf(target)
  const imports = specifier.startsWith('#') ? packageDirOf(importer) : null
  if (
    !(own !== null && conditionedPackage(state, own, diverging)) &&
    !(imports !== null && conditionedPackage(state, imports, diverging))
  ) {
    return false
  }
  let native: string | null = null
  try {
    const result = options.resolver.resolve(specifier, {
      importer,
      kind,
      conditions: NATIVE_CONDITIONS,
    })
    if (result.type === 'file') native = result.path
  } catch {
    // Node would not find it where the loader did: another outcome all the same.
  }
  return native !== target
}

/**
 * Whether `path`'s closure has an edge that Node, loading the file natively, would resolve to
 * another file than the loader does (`resolvesElsewhere`): under a DOM environment's `['browser']`,
 * a package whose `exports` map a `browser` build (Emotion's `.browser.cjs.js`) gets its Node build
 * from a native `require`, beside the browser build the file's own modules get. Such an external is
 * inlined, so its edges resolve as the loader's do from its first load, as under Jest, where every
 * module resolves with the environment's conditions. Kept per worker (`cachedReach`); `diverging`
 * is `divergingConditions`'s set, and with none nothing is asked.
 */
export function conditionalReach(
  state: InlineState,
  options: LoaderOptions,
  path: string,
  diverging: ReadonlySet<string>,
  userEdges: UserEdges,
): boolean {
  return cachedReach(
    state.conditional,
    state,
    options,
    path,
    (edge, importer) =>
      resolvesElsewhere(state, options, edge, importer, diverging) ? edge.specifier : null,
    userEdges,
  )
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
  const graph = graphOf(state, options)
  graph.add(path)
  const files: string[] = []
  for (const entry of graph.reachable(path)) {
    if (packageDirOf(entry.path) === own) files.push(entry.path)
  }
  return files
}
