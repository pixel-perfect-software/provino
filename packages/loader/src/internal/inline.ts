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
  type ThirdPartyGraph,
} from '../graph/index.ts'

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
}

export function createInlineState(): InlineState {
  return { graph: null, warned: new Set(), verdicts: new WeakMap() }
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
  const graph = graphOf(state, options)
  const asked = new Set<string>()
  const done = new Set<string>()
  const stack = [path]
  let dynamic = false

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
        // An edge out of node_modules that no mock takes is a user module the loader can read.
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
