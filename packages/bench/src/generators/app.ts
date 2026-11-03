import { pickDistinct, randomBelow, seededRandom } from '../internal/prng.ts'
import { GRAPH_SIZE, graphFiles, graphName, simulate } from './graph.ts'
import {
  commonFiles,
  FLAVOUR_DIR,
  type Flavour,
  type GeneratedFile,
  lines,
  pad,
  prologue,
  renderImport,
  testFiles,
} from './render.ts'

/**
 * Tests in every `app-N` file (Track 12 R5).
 * @public
 */
export const APP_TESTS_PER_FILE = 8

const APP_SEED = 500_001

function renderAppTest(index: number, flavour: Flavour): string {
  const random = seededRandom(APP_SEED + index)
  const picks = pickDistinct(random, GRAPH_SIZE, 3)
  const [a, b, c] = picks.map(graphName) as [string, string, string]
  const [ia, ib, ic] = picks as [number, number, number]
  const n1 = 1 + randomBelow(random, 20)
  const n2 = n1 + 1 + randomBelow(random, 10)
  const total = (module: number, n: number): number => simulate([module], n).total
  const closure = (module: number): number => simulate([module], 1).visited
  return lines([
    ...prologue(flavour),
    ...picks.map((pick) =>
      renderImport(flavour, {
        kind: 'namespace',
        name: graphName(pick),
        from: `../src/graph/${graphName(pick)}.js`,
      }),
    ),
    '',
    `describe('app ${pad(index, 4)}', () => {`,
    `  test('${a} totals ${total(ia, n1)} for n = ${n1}', () => {`,
    `    expect(${a}.compute(${n1})).toBe(${total(ia, n1)})`,
    '  })',
    '',
    `  test('${b} totals ${total(ib, n2)} for n = ${n2}', () => {`,
    `    expect(${b}.compute(${n2})).toBe(${total(ib, n2)})`,
    '  })',
    '',
    `  test('${c} totals ${total(ic, n1)} for n = ${n1}', () => {`,
    `    expect(${c}.compute(${n1})).toBe(${total(ic, n1)})`,
    '  })',
    '',
    `  test('${a} runs its ${closure(ia)} modules once each', () => {`,
    '    const memo = new Map()',
    `    ${a}.compute(${n1}, memo)`,
    `    expect(memo.size).toBe(${closure(ia)})`,
    "    expect([...memo.keys()]).toContain('m00')",
    '  })',
    '',
    `  test('${b} is within one of its total', () => {`,
    `    expect(${b}.compute(${n1})).toBeWithinRange(${total(ib, n1) - 1}, ${total(ib, n1) + 1})`,
    '  })',
    '',
    `  test('${a} grows with its input', () => {`,
    `    expect(${a}.compute(${n2})).toBeGreaterThan(${a}.compute(${n1}))`,
    '  })',
    '',
    "  test('the global beforeEach has run for each test so far', () => {",
    '    expect(globalThis.benchHooks.before).toBe(7)',
    '    expect(globalThis.benchHooks.after).toBe(6)',
    '  })',
    '',
    "  test('the global afterEach has run after each earlier test', () => {",
    '    expect(globalThis.benchHooks.before).toBe(8)',
    '    expect(globalThis.benchHooks.after).toBe(7)',
    '  })',
    '})',
  ])
}

/**
 * The files of an `app-N` suite for a flavour: N test files with exactly 8 tests each over the
 * shared graph, plus a setup file with a custom matcher and global hooks that the tests use.
 * @public
 */
export function appFiles(suite: string, count: number, flavour: Flavour): readonly GeneratedFile[] {
  return [
    ...commonFiles(suite, flavour),
    ...graphFiles(flavour),
    ...testFiles(FLAVOUR_DIR[flavour], 'app', count, (index) => renderAppTest(index, flavour)),
  ]
}
