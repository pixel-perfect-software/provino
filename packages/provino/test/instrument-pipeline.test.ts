// U6 end to end (B23b): the real Istanbul instrumenter in the real pipeline, under the Jest dialect's
// hoist policy, on a TypeScript file with a hoisted `jest.mock` factory. The counters are written
// after TypeScript is stripped and before the hoister. The strip is in place (D116), so the
// coverage data's positions are the TypeScript file's own and it embeds no input map: each
// statement, function and branch is on the TypeScript line it came from; the import rewrite the
// hoister adds afterwards counts nothing. The instrumenter's own table against
// `babel-plugin-istanbul` is `@provino/coverage`'s.
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { loadInstrumenter } from '@provino/coverage/runtime'
import { jestHoistPolicy } from '@provino/dialect-jest'
import { createPipeline } from '@provino/transform'
import type { IstanbulRange } from '@provino/types'

const { istanbulInstrumenter, readInitialCoverage } = await loadInstrumenter()

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

// Each marker is the line a mapped position must land on (1-based, in this text).
const SOURCE = [
  "import { helper } from './helper'", // 1
  "jest.mock('./helper', () => ({ helper: (n: number) => n * 2 }))", // 2
  'export function priced(n: number): number {', // 3
  '  if (n > 10) {', // 4
  '    return helper(n)', // 5
  '  }', // 6
  '  return n', // 7
  '}', // 8
  "export const label = (n: number): string => (n > 0 ? '+' + String(n) : String(n))", // 9
  '',
].join('\n')

function transformed() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-instrument-pipeline-')))
  roots.push(root)
  const pipeline = createPipeline({
    root,
    typescript: 'oxc',
    tsconfig: false,
    hoist: jestHoistPolicy,
    cache: false,
    instrumenter: istanbulInstrumenter(),
  })
  const filename = join(root, 'priced.ts')
  const record = pipeline.transform({
    filename,
    source: SOURCE,
    role: 'source',
    consumer: 'import',
    instrument: true,
  })
  return { record, filename }
}

/** The TypeScript line of each range: its own, since the strip keeps every position. */
function linesOf(ranges: readonly IstanbulRange[]): number[] {
  return ranges.map((range) => range.start.line)
}

test('the file is instrumented, the mock call still hoists and the factory keeps its counter', () => {
  const { record } = transformed()
  assert.deepEqual(
    record.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
    [],
  )
  assert.match(record.code, /cov_[a-z0-9]+\(\)/)
  assert.equal(record.staticMocks.length, 1)
  assert.deepEqual(
    record.staticMocks.map((mock) => mock.specifier),
    ['./helper'],
  )
  // The hoisted call is above the first counter's use and the late import comes after it.
  // The strip keeps the source's own text, quotes included.
  const mockAt = record.code.indexOf("jest.mock('./helper'")
  assert.ok(mockAt >= 0)
  assert.ok(mockAt < record.code.indexOf('__provino_import_0__'))
})

test('statements, functions and branches map back to their TypeScript lines', () => {
  const { record, filename } = transformed()
  const found = readInitialCoverage(record.code)
  assert.ok(found !== null, 'the initial coverage is in the instrumented code')
  const { coverageData } = found
  assert.equal(coverageData.path, filename)
  assert.equal(coverageData.inputSourceMap, undefined, 'no input map: positions are the source’s')

  const statementLines = linesOf(Object.values(coverageData.statementMap))
  assert.deepEqual(
    [...new Set(statementLines)].sort((a, b) => a - b),
    [2, 4, 5, 7, 9],
    'the factory, the if, the two returns and the arrow body',
  )
  const functionLines = linesOf(Object.values(coverageData.fnMap).map((fn) => fn.decl))
  assert.deepEqual(
    functionLines.sort((a, b) => a - b),
    [2, 2, 3, 9],
  )
  const branches = Object.values(coverageData.branchMap)
  assert.deepEqual(branches.map((branch) => branch.type).sort(), ['cond-expr', 'if'])
  for (const branch of branches) {
    // An `if` with no `else` has an empty second location (`{ start: {}, end: {} }`), as Jest's.
    // (The type says `line` is a number; the data has none there.)
    const lines = linesOf(
      branch.locations.filter(
        (location) => (location.start.line as number | undefined) !== undefined,
      ),
    )
    assert.ok(
      lines.every((line) => line === 4 || line === 9),
      `a branch maps to ${lines}`,
    )
  }
})

test('a JavaScript file the instrumenter cannot parse is a diagnostic naming the instrumenter', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-instrument-pipeline-')))
  roots.push(root)
  const pipeline = createPipeline({
    root,
    typescript: 'oxc',
    tsconfig: false,
    hoist: jestHoistPolicy,
    cache: false,
    instrumenter: istanbulInstrumenter(),
  })
  for (const [name, source] of [
    ['syntax.js', 'export const = ;\n'],
    ['dup.js', 'export const a = 1\nexport const a = 2\n'],
  ] as const) {
    const record = pipeline.transform({
      filename: join(root, name),
      source,
      role: 'source',
      consumer: 'import',
      instrument: true,
    })
    const errors = record.diagnostics.filter((d) => d.severity === 'error')
    assert.ok(
      errors.some((d) => d.code === 'COVERAGE_INSTRUMENT_FAILED'),
      `${name}: ${JSON.stringify(record.diagnostics)}`,
    )
    assert.ok(errors.every((d) => d.code !== 'TRANSFORMER_FAILED'))
  }
})

test('the import rewrite and the mock hoist add no statement of their own', () => {
  const { record } = transformed()
  const found = readInitialCoverage(record.code)
  assert.ok(found !== null)
  // The statements the TypeScript has, on their own lines (the `jest.mock` call, the factory's body
  // and the inner arrow's, the `if`, the two returns, the `const` and its arrow's body); the late
  // import is written after the counters and has none.
  assert.deepEqual(
    linesOf(Object.values(found.coverageData.statementMap)).sort((a, b) => a - b),
    [2, 2, 2, 4, 5, 7, 9, 9],
  )
  assert.match(record.code, /__provino_import_0__/)
})
