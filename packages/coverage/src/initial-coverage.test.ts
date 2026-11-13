// T8.10 part 1: `readInitialCoverage` against `istanbul-lib-instrument` 6.0.3's, the one Jest's
// CoverageReporter calls on the files no test loaded. Each side reads its own instrumenter's
// output for the same source; what they find (path and data) must be equal.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, test } from 'node:test'
import { readInitialCoverage } from './initial-coverage.ts'
import { istanbulInstrumenter } from './instrument.ts'
import { CASES } from './test-cases.ts'

const nodeRequire = createRequire(import.meta.url)

interface OracleInstrumenter {
  instrumentSync(code: string, filename: string): string
}
interface OracleModule {
  createInstrumenter(options: Record<string, unknown>): OracleInstrumenter
  readInitialCoverage(code: string): {
    path: string
    gcv: string
    coverageData: Record<string, unknown>
  } | null
}

function isOracle(value: unknown): value is OracleModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { createInstrumenter?: unknown }).createInstrumenter === 'function' &&
    typeof (value as { readInitialCoverage?: unknown }).readInitialCoverage === 'function'
  )
}

const oracle: unknown = nodeRequire('istanbul-lib-instrument')
if (!isOracle(oracle)) throw new Error('istanbul-lib-instrument has no createInstrumenter')

function essentials(data: unknown): unknown {
  const copy: Record<string, unknown> = JSON.parse(JSON.stringify(data))
  delete copy.hash
  delete copy._coverageSchema
  return copy
}

const FILE = '/virtual/project/src/case.js'

describe('readInitialCoverage against istanbul-lib-instrument 6.0.3', () => {
  for (const { name, code } of CASES) {
    test(`${name}: the same path, global and data`, () => {
      const theirs = oracle
        .createInstrumenter({ esModules: true, compact: false, produceSourceMap: false })
        .instrumentSync(code, FILE)
      const expected = oracle.readInitialCoverage(theirs)
      const mine = readInitialCoverage(istanbulInstrumenter().instrument(code, FILE, null).code)
      if (expected === null) {
        assert.equal(mine, null)
        return
      }
      assert.ok(mine !== null)
      assert.equal(mine.path, expected.path)
      assert.equal(mine.gcv, expected.gcv)
      assert.deepEqual(essentials(mine.coverageData), essentials(expected.coverageData))
    })
  }

  test('code with no instrumentation holds no initial coverage', () => {
    assert.equal(readInitialCoverage('export const x = 1;\n'), null)
  })
})
