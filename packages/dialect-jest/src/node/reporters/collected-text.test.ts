// The text of `--collectTests` over a built aggregate; the same text against live Jest 30.5.2 is
// `provino`'s `jest-collect-tests.test.ts`.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  type AssertionResult,
  addResult,
  makeCollectedTestResult,
  makeEmptyAggregatedTestResult,
} from '@provino/dialect-jest/results'
import { type CollectedTextStyle, jestCollectedText } from './collected-text.ts'

const plain: CollectedTextStyle = {
  bold: (text) => text,
  dim: (text) => text,
  red: (text) => text,
  green: (text) => text,
  yellow: (text) => text,
  magenta: (text) => text,
}

function assertion(
  ancestors: string[],
  title: string,
  status: AssertionResult['status'],
): AssertionResult {
  return {
    ancestorTitles: ancestors,
    failureDetails: [],
    failureMessages: [],
    fullName: [...ancestors, title].join(' '),
    numPassingAsserts: 0,
    status,
    title,
  }
}

describe('jestCollectedText', () => {
  it('prints each file, its tree and the summary', () => {
    const aggregated = makeEmptyAggregatedTestResult()
    aggregated.numTotalTestSuites = 1
    addResult(
      aggregated,
      makeCollectedTestResult(
        [
          assertion(['outer'], 'first', 'passed'),
          assertion(['outer', 'inner'], 'second', 'pending'),
          assertion(['outer', 'inner'], 'third', 'todo'),
          assertion([], 'top level', 'passed'),
        ],
        { displayName: undefined, testFilePath: '/p/a.test.ts' },
      ),
    )
    assert.equal(
      jestCollectedText(aggregated, plain),
      [
        '/p/a.test.ts',
        '  top level',
        '  outer',
        '    first',
        '    inner',
        '      second [skipped]',
        '      third [todo]',
        '',
        'Test suites: 1',
        'Tests:       4 total, 2 runnable, 1 skipped, 1 todo',
        '',
      ].join('\n'),
    )
  })

  it('prints a file that failed to load with its message, and says how many', () => {
    const aggregated = makeEmptyAggregatedTestResult()
    aggregated.numTotalTestSuites = 1
    addResult(aggregated, {
      ...makeCollectedTestResult([], { displayName: undefined, testFilePath: '/p/b.test.ts' }),
      testExecError: { message: 'cannot load', stack: null },
    })
    assert.equal(
      jestCollectedText(aggregated, plain),
      '/p/b.test.ts\ncannot load\n\nTest suites: 1\nTests:       0 total\n\n1 test suite(s) failed to load and could not be collected.\n',
    )
  })
})
