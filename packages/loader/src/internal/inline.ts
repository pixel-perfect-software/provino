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
import { buildThirdPartyGraph, type ThirdPartyGraph } from '../graph/index.ts'

/** The default for `LoaderOptions.inlineBudget`. */
export const DEFAULT_INLINE_BUDGET = 400

/** The worker-wide half of inlining: the graph, built on first use, and what was warned. */
export interface InlineState {
  /** Built on the first external that is asked about while mocks are active. */
  graph: ThirdPartyGraph | null
  /** The mocked ids whose budget warning went out, and the dynamic closures reported. */
  readonly warned: Set<string>
  /** The first scan, for a test or a bench to see that nothing was scanned. */
  scans: number
}

export function createInlineState(): InlineState {
  return { graph: null, warned: new Set(), scans: 0 }
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
    conditions: options.conditions ?? ['node'],
    cacheDir: options.graphCache ?? null,
  })
  return state.graph
}

/** Writes what the graph scanned to its cache. */
export function saveGraph(state: InlineState): void {
  state.graph?.save()
}

/**
 * The first id among the edges of `path`'s closure that `mocks` takes, or `null` when none is.
 * `path` is a real file under `node_modules`. The graph is extended to its closure first.
 */
export function mockedReach(
  state: InlineState,
  options: LoaderOptions,
  path: string,
  mocks: ModuleMockRegistry,
): string | null {
  const graph = graphOf(state, options)
  if (!graph.has(path)) {
    const before = graph.scanned
    graph.add(path)
    if (graph.scanned > before) state.scans++
  }
  const asked = new Set<string>()
  let dynamic = false
  for (const { path: importer, node } of graph.reachable(path)) {
    if (node.dynamic) dynamic = true
    for (const edge of node.edges) {
      const style = edge.kind === 'require' ? 'cjs' : 'esm'
      const key = `${style}\0${edge.target ?? ''}\0${edge.specifier}`
      if (asked.has(key)) continue
      asked.add(key)
      if (edge.target === null) {
        try {
          if (mocks.decideUnresolved(edge.specifier, importer).mocked) return edge.specifier
        } catch {
          // A mock that can't stand in (Vitest's relative path) is the edge's own error to raise.
        }
        continue
      }
      const decision = mocks.decide(
        edge.target,
        importer,
        edge.target.startsWith('node:') ? 'builtin' : style,
        edge.specifier,
      )
      if (decision.mocked) return decision.id
    }
  }
  // A computed `require` in a shared closure is an edge the graph can't see: a miss, if one was due.
  if (dynamic && !state.warned.has(path)) {
    state.warned.add(path)
    warn(options, {
      code: 'PROVINO_INLINE_DYNAMIC',
      level: 'debug',
      message: `${path} (or a module it loads) requires a computed specifier, so a mock may not reach what it loads.`,
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
