import { randomBelow, seededRandom } from '../internal/prng.ts'
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
 * Test files in `isolate-heavy`.
 * @public
 */
export const ISOLATE_HEAVY_FILES = 30

/**
 * Tests in every `isolate-heavy` file.
 * @public
 */
export const ISOLATE_HEAVY_TESTS_PER_FILE = 3

/**
 * Records in the big module, chosen so the source comes to about 2 MB.
 * @public
 */
export const BIG_RECORD_COUNT = 24_000

const BIG_SEED = 2_000_001

/**
 * One row of the big module.
 * @public
 */
export interface BigRecord {
  readonly id: number
  readonly score: number
  readonly group: number
  readonly flags: readonly [number, number, number, number]
}

/**
 * The big module's records, from `BIG_SEED`. A suite builds them once and renders them for both
 * flavours.
 * @public
 */
export function bigRecords(): readonly BigRecord[] {
  const random = seededRandom(BIG_SEED)
  const records: BigRecord[] = []
  for (let id = 0; id < BIG_RECORD_COUNT; id++) {
    records.push({
      id,
      score: randomBelow(random, 1000),
      group: randomBelow(random, 16),
      flags: [
        randomBelow(random, 2),
        randomBelow(random, 2),
        randomBelow(random, 2),
        randomBelow(random, 2),
      ],
    })
  }
  return records
}

function recordLiteral(record: BigRecord): string {
  return `{ id: ${record.id}, name: 'record-${record.id}', score: ${record.score}, group: 'g${record.group}', flags: [${record.flags.join(', ')}] }`
}

// The big module (about 2 MB): a table of records, a `lookup` by id, and a `total` score summed at
// load.
function renderBig(all: readonly BigRecord[], flavour: Flavour): string {
  return lines([
    ...prologue(flavour),
    'const records = [',
    ...all.map((record) => `  ${recordLiteral(record)},`),
    ']',
    '',
    'const count = records.length',
    '',
    'let total = 0',
    'for (const record of records) total += record.score',
    '',
    'function lookup(id) {',
    '  return records[id]',
    '}',
    '',
    renderExports(flavour, ['records', 'count', 'total', 'lookup']),
  ])
}

function renderIsolateHeavyTest(
  index: number,
  flavour: Flavour,
  records: readonly BigRecord[],
): string {
  const total = records.reduce((sum, record) => sum + record.score, 0)
  const random = seededRandom(BIG_SEED + 1 + index)
  const record = records[randomBelow(random, records.length)]
  if (record === undefined) throw new RangeError('the big module has no records')
  return lines([
    ...prologue(flavour),
    renderImport(flavour, { kind: 'namespace', name: 'big', from: '../src/big.js' }),
    '',
    `describe('isolate-heavy ${pad(index, 2)}', () => {`,
    "  test('holds every record', () => {",
    `    expect(big.count).toBe(${records.length})`,
    `    expect(big.records).toHaveLength(${records.length})`,
    '  })',
    '',
    "  test('adds up to the expected score', () => {",
    `    expect(big.total).toBe(${total})`,
    '  })',
    '',
    `  test('finds record ${record.id}', () => {`,
    `    expect(big.lookup(${record.id})).toEqual(${recordLiteral(record)})`,
    '  })',
    '})',
  ])
}

/**
 * The files of the `isolate-heavy` suite for a flavour: 30 test files that each import one
 * generated ~2 MB module and assert on it. `records` come from `bigRecords`.
 * @public
 */
export function isolateHeavyFiles(
  suite: string,
  flavour: Flavour,
  records: readonly BigRecord[],
): readonly GeneratedFile[] {
  const dir = FLAVOUR_DIR[flavour]
  return [
    ...commonFiles(suite, flavour),
    { path: `${dir}/src/big.js`, contents: renderBig(records, flavour) },
    ...testFiles(
      dir,
      'big',
      ISOLATE_HEAVY_FILES,
      (index) => renderIsolateHeavyTest(index, flavour, records),
      2,
    ),
  ]
}
