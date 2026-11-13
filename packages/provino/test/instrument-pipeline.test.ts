// U6 end to end (B23b): the real Istanbul instrumenter in the real pipeline, under the Jest dialect's
// hoist policy, on a TypeScript file with a hoisted `jest.mock` factory. The counters are written
// after TypeScript is stripped and before the hoister, so the coverage data's positions are those
// of the stripped code and its embedded input map leads each statement, function and branch back
// to the TypeScript line it came from; the import rewrite the hoister adds afterwards counts
// nothing. The instrumenter's own table against `babel-plugin-istanbul` is `@provino/coverage`'s.
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { SourceMap } from 'node:module'
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

function linesOf(map: SourceMap, ranges: readonly IstanbulRange[]): number[] {
  return ranges.map((range) => {
    const entry = map.findEntry(range.start.line - 1, range.start.column ?? 0)
    // `findEntry` returns an empty object when nothing maps there.
    assert.ok('originalLine' in entry, `no mapping at ${JSON.stringify(range.start)}`)
    return entry.originalLine + 1
  })
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
  const mockAt = record.code.indexOf('jest.mock("./helper"')
  assert.ok(mockAt >= 0)
  assert.ok(mockAt < record.code.indexOf('__provino_import_0__'))
})

test('statements, functions and branches map back to their TypeScript lines', () => {
  const { record, filename } = transformed()
  const found = readInitialCoverage(record.code)
  assert.ok(found !== null, 'the initial coverage is in the instrumented code')
  const { coverageData } = found
  assert.equal(coverageData.path, filename)
  assert.ok(coverageData.inputSourceMap !== undefined, 'the input map is embedded')
  const map = new SourceMap(coverageData.inputSourceMap as never)

  const statementLines = linesOf(map, Object.values(coverageData.statementMap))
  assert.deepEqual(
    [...new Set(statementLines)].sort((a, b) => a - b),
    [2, 4, 5, 7, 9],
    'the factory, the if, the two returns and the arrow body',
  )
  const functionLines = linesOf(
    map,
    Object.values(coverageData.fnMap).map((fn) => fn.decl),
  )
  assert.deepEqual(
    functionLines.sort((a, b) => a - b),
    [2, 2, 3, 9],
  )
  const branches = Object.values(coverageData.branchMap)
  assert.deepEqual(branches.map((branch) => branch.type).sort(), ['cond-expr', 'if'])
  for (const branch of branches) {
    const lines = linesOf(map, branch.locations)
    assert.ok(
      lines.every((line) => line === 4 || line === 9),
      `a branch maps to ${lines}`,
    )
  }
})

test('the import rewrite and the mock hoist add no statement of their own', () => {
  const { record } = transformed()
  const found = readInitialCoverage(record.code)
  assert.ok(found !== null)
  const map = new SourceMap(found.coverageData.inputSourceMap as never)
  // The statements the TypeScript has, on their own lines (the `jest.mock` call, the factory's body
  // and the inner arrow's, the `if`, the two returns, the `const` and its arrow's body); the late
  // import is written after the counters and has none.
  assert.deepEqual(
    linesOf(map, Object.values(found.coverageData.statementMap)).sort((a, b) => a - b),
    [2, 2, 2, 4, 5, 7, 9, 9],
  )
  assert.match(record.code, /__provino_import_0__/)
})
