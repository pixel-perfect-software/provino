// The rebuilt helpers against the real `@jest/test-result` 30.5.2, on synthetic inputs.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as real from '@jest/test-result'
import {
  addResult,
  buildFailureTestResult,
  createEmptyTestResult,
  makeCollectedTestResult,
  makeEmptyAggregatedTestResult,
} from './helpers.ts'
import type { AssertionResult, TestResult } from './types.ts'

const assertion = (status: AssertionResult['status'], title: string): AssertionResult => ({
  ancestorTitles: ['suite'],
  duration: status === 'passed' ? 3 : null,
  failing: false,
  failureDetails: [],
  failureMessages: status === 'failed' ? ['Error: boom'] : [],
  fullName: `suite ${title}`,
  invocations: 1,
  location: null,
  numPassingAsserts: 0,
  retryMessages: [],
  retryReasons: [],
  startAt: 1,
  status,
  title,
})

function fileResult(path: string, patch: Partial<TestResult>): TestResult {
  return { ...createEmptyTestResult(), testFilePath: path, ...patch }
}

describe('the rebuilt helpers equal @jest/test-result', () => {
  it('builds the same empty results', () => {
    assert.deepEqual(makeEmptyAggregatedTestResult(), real.makeEmptyAggregatedTestResult())
    assert.deepEqual(createEmptyTestResult(), real.createEmptyTestResult())
  })

  it('builds the same failure result', () => {
    const error = { message: 'cannot load', stack: 'Error: cannot load\n    at x (/a.ts:1:1)' }
    assert.deepEqual(
      buildFailureTestResult('/a.test.ts', error),
      real.buildFailureTestResult('/a.test.ts', error),
    )
  })

  it('folds files into the aggregate the same way', () => {
    const files: TestResult[] = [
      fileResult('/pass.test.ts', { numPassingTests: 2 }),
      fileResult('/fail.test.ts', {
        numFailingTests: 1,
        numPassingTests: 1,
        snapshot: {
          added: 1,
          fileDeleted: false,
          matched: 2,
          unchecked: 1,
          uncheckedKeys: ['a 1'],
          unmatched: 1,
          updated: 0,
        },
      }),
      fileResult('/skip.test.ts', { skipped: true, numPendingTests: 2 }),
      fileResult('/todo.test.ts', { numTodoTests: 3 }),
      buildFailureTestResult('/exec.test.ts', { message: 'm', stack: 's' }),
      fileResult('/gone.test.ts', {
        snapshot: {
          added: 0,
          fileDeleted: true,
          matched: 0,
          unchecked: 0,
          uncheckedKeys: [],
          unmatched: 0,
          updated: 4,
        },
      }),
    ]
    const ours = makeEmptyAggregatedTestResult()
    const theirs = real.makeEmptyAggregatedTestResult()
    for (const file of files) {
      addResult(ours, structuredClone(file))
      real.addResult(theirs, structuredClone(file) as never)
    }
    assert.deepEqual(ours, theirs)
    assert.equal(ours.numTotalTests, 9)
    assert.equal(ours.snapshot.filesUnmatched, 1)
  })

  it('counts a result with no numTodoTests as zero, as Jest does', () => {
    const missing = { ...createEmptyTestResult(), numTodoTests: undefined } as unknown as TestResult
    const ours = makeEmptyAggregatedTestResult()
    addResult(ours, missing)
    assert.equal(ours.numTodoTests, 0)
    assert.equal(missing.numTodoTests, 0)
  })

  it('tallies a collected file by status', () => {
    const tests = [
      assertion('passed', 'a'),
      assertion('failed', 'b'),
      assertion('pending', 'c'),
      assertion('todo', 'd'),
      assertion('passed', 'e'),
    ]
    const options = { displayName: undefined, testFilePath: '/c.test.ts' }
    assert.deepEqual(
      makeCollectedTestResult(tests, options),
      real.makeCollectedTestResult(tests, options),
    )
  })
})
