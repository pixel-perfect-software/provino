import { pickDistinct, seededRandom } from '../internal/prng.ts'
import { GRAPH_SIZE, graphFiles, graphName, simulate } from './graph.ts'
import {
  commonFiles,
  FLAVOUR_DIR,
  type Flavour,
  type GeneratedFile,
  lines,
  pad,
  prologue,
  renderExports,
  renderImport,
  testFiles,
} from './render.ts'

/**
 * Tests in every `mock-heavy-N` file.
 * @public
 */
export const MOCK_HEAVY_TESTS_PER_FILE = 4

/**
 * Consumer modules the test files share. A consumer imports a few of the graph's top modules and
 * so reaches every mocked module only through the graph.
 */
const CONSUMER_COUNT = 8

const MOCK_HEAVY_SEED = 700_001
const MOCKS_PER_FILE = 3

// Consumers import from the top five modules; mocks come from below them, so a mock is never a
// direct dependency of a consumer.
const CONSUMER_POOL_START = GRAPH_SIZE - 5
const MOCK_POOL_START = 6

function consumerDeps(consumer: number): number[] {
  const random = seededRandom(MOCK_HEAVY_SEED + 1000 + consumer)
  const picks = pickDistinct(random, GRAPH_SIZE - CONSUMER_POOL_START, 2 + (consumer % 2))
  return picks.map((pick) => CONSUMER_POOL_START + pick)
}

// A consumer: `run(n)` sums its graph modules' `compute` with one shared memo and reports the
// total and how many modules ran.
function renderConsumer(consumer: number, flavour: Flavour): string {
  const deps = consumerDeps(consumer)
  return lines([
    ...prologue(flavour),
    ...deps.map((dep) =>
      renderImport(flavour, {
        kind: 'namespace',
        name: graphName(dep),
        from: `../graph/${graphName(dep)}.js`,
      }),
    ),
    '',
    'function run(n) {',
    '  const memo = new Map()',
    `  const total = ${deps.map((dep) => `${graphName(dep)}.compute(n, memo)`).join(' + ')}`,
    '  return { total, visited: memo.size }',
    '}',
    '',
    renderExports(flavour, ['run']),
  ])
}

interface MockPlan {
  readonly consumer: number
  /** Module index to the constant its mocked `compute` returns. */
  readonly mocks: ReadonlyMap<number, number>
}

// Picks three modules to mock. Each must really be reached through the graph (another mock above
// it could cut it off), so a mock that nothing calls is re-drawn.
function planMocks(index: number): MockPlan {
  const random = seededRandom(MOCK_HEAVY_SEED + index)
  const consumer = index % CONSUMER_COUNT
  const roots = consumerDeps(consumer)
  for (let attempt = 0; attempt < 1000; attempt++) {
    const picks = pickDistinct(random, CONSUMER_POOL_START - MOCK_POOL_START, MOCKS_PER_FILE)
    const mocks = new Map(
      picks.map((pick) => [MOCK_POOL_START + pick, 7_000_000 + MOCK_POOL_START + pick] as const),
    )
    const { calls } = simulate(roots, 1, mocks)
    if ([...mocks.keys()].every((module) => (calls.get(module) ?? 0) > 0)) {
      return { consumer, mocks }
    }
  }
  throw new RangeError(`no reachable mock set for mock-heavy file ${index}`)
}

function renderMockHeavyTest(index: number, flavour: Flavour): string {
  const { consumer, mocks } = planMocks(index)
  const roots = consumerDeps(consumer)
  const modules = [...mocks.keys()]
  const tool = flavour === 'cjs' ? 'jest' : 'vi'
  const first = simulate(roots, 3, mocks)
  const second = simulate(roots, 11, mocks)
  const names = modules.map(graphName)
  return lines([
    ...prologue(flavour),
    ...[...mocks].map(
      ([module, value]) =>
        `${tool}.mock('../src/graph/${graphName(module)}.js', () => ({ name: '${graphName(module)}', compute: ${tool}.fn(() => ${value}) }))`,
    ),
    '',
    renderImport(flavour, {
      kind: 'namespace',
      name: 'consumer',
      from: `../src/consumers/c${consumer}.js`,
    }),
    ...names.map((name) =>
      renderImport(flavour, { kind: 'namespace', name, from: `../src/graph/${name}.js` }),
    ),
    '',
    `describe('mock-heavy ${pad(index, 4)}', () => {`,
    "  test('mocked values flow through the shared graph', () => {",
    `    expect(consumer.run(3).total).toBe(${first.total})`,
    '  })',
    '',
    "  test('only the modules reached outside the mocks run', () => {",
    `    expect(consumer.run(3).visited).toBe(${first.visited})`,
    '  })',
    '',
    "  test('each mock is called once for every module that depends on it', () => {",
    ...names.map((name) => `    ${name}.compute.mockClear()`),
    '    consumer.run(3)',
    ...modules.map(
      (module) =>
        `    expect(${graphName(module)}.compute).toHaveBeenCalledTimes(${first.calls.get(module)})`,
    ),
    '  })',
    '',
    "  test('another input gives its own total', () => {",
    `    expect(consumer.run(11).total).toBe(${second.total})`,
    '  })',
    '})',
  ])
}

/**
 * The files of a `mock-heavy-N` suite for a flavour: N test files that each mock three graph
 * modules with factories (no automock) and assert, through a consumer, that the mocked values
 * flow through the graph.
 * @public
 */
export function mockHeavyFiles(
  suite: string,
  count: number,
  flavour: Flavour,
): readonly GeneratedFile[] {
  const dir = FLAVOUR_DIR[flavour]
  const consumers: GeneratedFile[] = []
  for (let consumer = 0; consumer < CONSUMER_COUNT; consumer++) {
    consumers.push({
      path: `${dir}/src/consumers/c${consumer}.js`,
      contents: renderConsumer(consumer, flavour),
    })
  }
  return [
    ...commonFiles(suite, flavour),
    ...graphFiles(flavour),
    ...consumers,
    ...testFiles(dir, 'mock', count, (index) => renderMockHeavyTest(index, flavour)),
  ]
}
