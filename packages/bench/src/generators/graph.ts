import { randomBelow, seededRandom } from '../internal/prng.ts'
import {
  type Binding,
  FLAVOUR_DIR,
  type Flavour,
  type GeneratedFile,
  lines,
  pad,
  prologue,
  renderExports,
  renderImport,
} from './render.ts'

/**
 * Which library a graph module's own work goes through.
 * @public
 */
export type GraphKind = 'zod' | 'date' | 'collection'

/**
 * One module of the shared graph.
 * @public
 */
export interface GraphNode {
  readonly index: number
  /** `m07`; also the file name (`m07.js`) and the key the module memoizes under. */
  readonly name: string
  readonly kind: GraphKind
  /** The module's own work is `weight * n`, routed through its library. */
  readonly weight: number
  /** Lower-numbered modules it imports. */
  readonly deps: readonly number[]
}

/**
 * Modules in the shared graph (Track 12 R5).
 * @public
 */
export const GRAPH_SIZE = 24

/**
 * Seed of the graph's shape. Changing it changes every suite and so invalidates every recorded
 * baseline.
 */
const GRAPH_SEED = 24_001

const KINDS: readonly GraphKind[] = ['zod', 'date', 'collection']

/**
 * The module name for an index: `m00` to `m23`.
 * @public
 */
export function graphName(index: number): string {
  return `m${pad(index, 2)}`
}

/**
 * Builds the graph: 24 modules, each importing lower-numbered ones (always the one just below it,
 * so the graph is connected, plus one or two others), working through zod, date-fns and lodash in
 * turn. The same seed always gives the same graph.
 * @public
 */
export function buildGraph(seed: number = GRAPH_SEED): readonly GraphNode[] {
  const random = seededRandom(seed)
  const nodes: GraphNode[] = []
  for (let index = 0; index < GRAPH_SIZE; index++) {
    const deps = new Set<number>()
    if (index >= 1) deps.add(index - 1)
    if (index >= 2) deps.add(randomBelow(random, index - 1))
    if (index >= 9 && index % 3 === 0) deps.add(randomBelow(random, index - 1))
    nodes.push({
      index,
      name: graphName(index),
      kind: KINDS[index % KINDS.length] ?? 'zod',
      weight: 1 + randomBelow(random, 9),
      deps: [...deps].sort((a, b) => a - b),
    })
  }
  return nodes
}

/**
 * The graph every suite uses.
 * @public
 */
export const GRAPH: readonly GraphNode[] = buildGraph()

function libraryImport(kind: GraphKind): Binding {
  switch (kind) {
    case 'zod':
      return { kind: 'named', names: ['z'], from: 'zod' }
    case 'date':
      return {
        kind: 'named',
        names: ['addMinutes', 'differenceInMinutes', 'isAfter'],
        from: 'date-fns',
      }
    case 'collection':
      return { kind: 'default', name: '_', from: 'lodash' }
  }
}

// Each body turns `n` into `weight * n` through its library, so a module's value is exact
// integer arithmetic the generator can predict without running any library. Dates are fixed UTC
// instants and only millisecond-based date-fns functions are used, so nothing depends on the
// timezone, the locale or the clock.
function ownWork(node: GraphNode): readonly string[] {
  switch (node.kind) {
    case 'zod':
      return [
        'const schema = z.object({ n: z.number().int().min(0), tag: z.string().min(1) })',
        '',
        'function own(n) {',
        `  return schema.parse({ n: n * ${node.weight}, tag: name }).n`,
        '}',
      ]
    case 'date':
      return [
        'const start = new Date(Date.UTC(2024, 0, 15, 12, 0, 0))',
        '',
        'function own(n) {',
        `  const later = addMinutes(start, n * ${node.weight})`,
        '  return isAfter(later, start) ? differenceInMinutes(later, start) : 0',
        '}',
      ]
    case 'collection':
      return [
        'function own(n) {',
        `  const parts = _.chunk(_.fill(Array(${node.weight}), n), 2)`,
        '  return _.sumBy(parts, (part) => _.sum(part))',
        '}',
      ]
  }
}

// One graph module. It exports `name` and `compute(n, memo)`: its own work plus the `compute` of
// each dependency, memoized by name in the `memo` map so a shared dependency does the library work
// once per call.
function renderGraphModule(node: GraphNode, flavour: Flavour): string {
  const imports = [
    renderImport(flavour, libraryImport(node.kind)),
    ...node.deps.map((dep) =>
      renderImport(flavour, {
        kind: 'namespace',
        name: graphName(dep),
        from: `./${graphName(dep)}.js`,
      }),
    ),
  ]
  const terms = ['own(n)', ...node.deps.map((dep) => `${graphName(dep)}.compute(n, memo)`)]
  return lines([
    ...prologue(flavour),
    ...imports,
    '',
    `const name = '${node.name}'`,
    '',
    ...ownWork(node),
    '',
    'function compute(n, memo = new Map()) {',
    '  if (memo.has(name)) return memo.get(name)',
    `  const value = ${terms.join(' + ')}`,
    '  memo.set(name, value)',
    '  return value',
    '}',
    '',
    renderExports(flavour, ['name', 'compute']),
  ])
}

/**
 * What `compute` from the given modules returns and does, simulated from the model alone.
 * @public
 */
export interface Simulation {
  /** The sum of the roots' values. */
  readonly total: number
  /** Entries in the memo afterwards: the modules that really ran. Mocked ones add none. */
  readonly visited: number
  /** How many times each mocked module's `compute` was called. */
  readonly calls: ReadonlyMap<number, number>
}

/**
 * Runs `GRAPH`'s `compute` on paper: sums `roots` the way a consumer would, sharing one memo.
 * `mocks` maps a module index to the constant its mocked `compute` returns; a mocked module cuts
 * off everything below it.
 * @public
 */
export function simulate(
  roots: readonly number[],
  n: number,
  mocks: ReadonlyMap<number, number> = new Map(),
): Simulation {
  const memo = new Map<number, number>()
  const calls = new Map<number, number>()
  const compute = (index: number): number => {
    const mocked = mocks.get(index)
    if (mocked !== undefined) {
      calls.set(index, (calls.get(index) ?? 0) + 1)
      return mocked
    }
    const cached = memo.get(index)
    if (cached !== undefined) return cached
    const node = GRAPH[index]
    if (node === undefined) throw new RangeError(`no graph module ${index}`)
    let value = node.weight * n
    for (const dep of node.deps) value += compute(dep)
    memo.set(index, value)
    return value
  }
  let total = 0
  for (const root of roots) total += compute(root)
  return { total, visited: memo.size, calls }
}

/**
 * Renders the 24 graph modules for a flavour, under `src/graph/` in the flavour's tree.
 * @public
 */
export function graphFiles(flavour: Flavour): readonly GeneratedFile[] {
  return GRAPH.map((node) => ({
    path: `${FLAVOUR_DIR[flavour]}/src/graph/${node.name}.js`,
    contents: renderGraphModule(node, flavour),
  }))
}
