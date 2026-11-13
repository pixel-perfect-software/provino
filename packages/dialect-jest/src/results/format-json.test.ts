// `formatJson` against the real `formatTestResults` of @jest/test-result 30.5.2, and
// `serializeToJson` against what `serializeToJSON` says it does.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as real from '@jest/test-result'
import { formatJson, serializeToJson } from './format-json.ts'
import { addResult, createEmptyTestResult, makeEmptyAggregatedTestResult } from './helpers.ts'
import type { TestResult } from './types.ts'

function file(path: string, patch: Partial<TestResult>): TestResult {
  const base = createEmptyTestResult()
  return {
    ...base,
    testFilePath: path,
    perfStats: { ...base.perfStats, start: 10, end: 20 },
    ...patch,
  }
}

describe('formatJson equals formatTestResults', () => {
  it('formats a passed, a focused, a failed, a skipped and an unrunnable file', () => {
    const aggregated = makeEmptyAggregatedTestResult()
    for (const result of [
      file('/passed.test.ts', { numPassingTests: 1 }),
      file('/focused.test.ts', { numPassingTests: 1, numPendingTests: 1, failureMessage: 'x' }),
      file('/failed.test.ts', { numFailingTests: 1, failureMessage: '  ● a › b\n' }),
      file('/skipped.test.ts', { skipped: true, numPendingTests: 1 }),
      file('/exec.test.ts', {
        testExecError: { message: 'cannot load', stack: 's' },
        failureMessage: 'formatted',
      }),
      file('/exec-bare.test.ts', { testExecError: { message: 'bare', stack: 's' } }),
    ]) {
      addResult(aggregated, result)
    }
    const ours = formatJson(aggregated)
    const theirs = real.formatTestResults(structuredClone(aggregated) as never)
    // The two kinds that read the clock say `now`; compare them without it.
    const drop = (value: typeof ours): unknown => ({
      ...value,
      testResults: value.testResults.map((entry) =>
        entry.status === 'skipped' || entry.message === 'formatted' || entry.message === 'bare'
          ? { ...entry, startTime: 0, endTime: 0 }
          : entry,
      ),
    })
    assert.deepEqual(drop(ours), drop(theirs as unknown as typeof ours))
    assert.deepEqual(
      ours.testResults.map((entry) => entry.status),
      ['passed', 'focused', 'failed', 'skipped', 'failed', 'failed'],
    )
  })

  it('keeps the keys a processor added', () => {
    const aggregated = Object.assign(makeEmptyAggregatedTestResult(), { added: true })
    assert.equal((formatJson(aggregated) as unknown as { added: boolean }).added, true)
  })
})

describe('serializeToJson', () => {
  it('is JSON.stringify for plain data', () => {
    const value = { a: [1, 'two', null], b: { c: true } }
    assert.equal(serializeToJson(value), JSON.stringify(value))
    assert.equal(serializeToJson(value, 2), JSON.stringify(value, null, 2))
  })

  it('writes a bigint as its literal and an error as message, name and stack', () => {
    const error = new TypeError('bad')
    const parsed = JSON.parse(serializeToJson({ n: 12n, error })) as {
      n: string
      error: Record<string, unknown>
    }
    assert.equal(parsed.n, '12n')
    assert.deepEqual(Object.keys(parsed.error).sort(), ['message', 'name', 'stack'])
    assert.equal(parsed.error.name, 'TypeError')
  })
})
