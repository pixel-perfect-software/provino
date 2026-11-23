// A file that failed whole after its tests ended (`FileResult.resultsDiscarded`: a leak found by
// `--detectLeaks`, an inline snapshot that could not be written) counts none of its tests, in every
// reporter that totals them: the text summary, `json` and `junit` must agree with the file's state.
import assert from 'node:assert/strict'
import type { NormalizedRun } from '@provino/types'
import { describe, test } from 'provino'
import { createReporterBus } from './bus.ts'
import { defaultReporter } from './default/reporter.ts'
import {
  error,
  type FileSpec,
  JEST_REPORT,
  output,
  playRun,
  playThrough,
} from './internal/test-support.ts'
import { junitReporter } from './junit/reporter.ts'
import { normalizedJsonReporter } from './normalized-json/reporter.ts'

const FILES: readonly FileSpec[] = [
  {
    path: 'leak.test.ts',
    state: 'fail',
    resultsDiscarded: true,
    errors: [error('the file leaks')],
    tests: [{ path: ['passes'] }, { path: ['fails'], state: 'fail', errors: [error('no')] }],
  },
  { path: 'ok.test.ts', tests: [{ path: ['fine'] }] },
]

describe('a file whose results are discarded', () => {
  test('counts no test in the text summary, and is one failed suite', async () => {
    const text = await playThrough(
      (stream) => defaultReporter({ stream, report: JEST_REPORT }),
      FILES,
    )
    assert.match(text, /^Test Suites: 1 failed, 1 passed, 2 total$/m)
    assert.match(text, /^Tests: {7}1 passed, 1 total$/m)
  })

  test('lists no test of it in json', async () => {
    const out = output()
    const bus = createReporterBus([
      normalizedJsonReporter({
        stream: out,
        suite: 's',
        runner: 'provino:test',
        runnerVersion: '0',
      }),
    ])
    await playRun(bus, FILES, {})
    const run = JSON.parse(out.text()) as NormalizedRun
    const leak = run.files.find((file) => file.file === 'leak.test.ts')
    assert.deepEqual(leak?.tests ?? [], [])
    assert.equal(leak?.status, 'crashed')
    assert.equal(run.files.find((file) => file.file === 'ok.test.ts')?.tests.length, 1)
  })

  test('lists no test of it in junit, only the file’s error: tests, failures and errors agree', async () => {
    const text = await playThrough(
      (stream) => junitReporter({ stream, report: JEST_REPORT }),
      FILES,
    )
    assert.match(text, /<testsuite name="leak\.test\.ts" tests="1" failures="0" errors="1"/)
    assert.doesNotMatch(text, /name="passes"|name="fails"/)
    assert.match(text, /<testsuites [^>]*tests="2"/)
  })
})
