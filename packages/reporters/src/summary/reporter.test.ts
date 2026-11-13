// The summary reporter (T11.9, B23a): the block Jest's `SummaryReporter` prints after the files, on
// the fixture run, and what `summary: false`, `failureText` and the threshold change in the text
// reporters it follows. The claims about Jest's own text are held by `provino`'s
// `jest-reporters.test.ts` against recordings; these goldens pin Provino's text.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Reporter } from '@provino/types'
import { defaultReporter } from '../default/reporter.ts'
import { expectGolden } from '../internal/golden.ts'
import { FIXTURE_FILES, JEST_REPORT, playFixture, playThrough } from '../internal/test-support.ts'
import { summaryReporter } from './reporter.ts'

/** The events a run sends, which `together` forwards to each reporter in turn. */
const EVENTS = [
  'run:start',
  'file:queued',
  'file:start',
  'file:collected',
  'task:start',
  'test:attempt-start',
  'test:attempt-end',
  'task:end',
  'hook:start',
  'hook:end',
  'annotation',
  'console',
  'unhandled',
  'file:end',
  'run:end',
  'error',
] as const

/** Several reporters as one, so a fixture run can be played through all of them. */
function together(...reporters: Reporter[]): Reporter {
  const handlers: Record<string, (...args: unknown[]) => Promise<void>> = {}
  for (const event of EVENTS) {
    handlers[event] = async (...args) => {
      for (const reporter of reporters) {
        const handler = reporter[event] as ((...a: unknown[]) => unknown) | undefined
        await handler?.(...args)
      }
    }
  }
  return { name: 'together', ...handlers }
}

const PLAIN = { report: JEST_REPORT, colour: false, live: false, columns: 80 } as const

describe('the summary reporter', () => {
  test('prints the totals alone, after a blank line when the last file did not fail', async () => {
    const { text } = await playFixture((out) => summaryReporter({ stream: out, ...PLAIN }))
    assert.doesNotMatch(text, /PASS|FAIL/)
    assert.match(text, /Test Suites:/)
    await expectGolden('summary.plain', text)
  })

  test('reprints each failed file under "Summary of all failing tests" past the threshold', async () => {
    const { text } = await playFixture((out) =>
      summaryReporter({ stream: out, ...PLAIN, failureSummaryThreshold: 1 }),
    )
    assert.match(text, /^Summary of all failing tests$/m)
    assert.match(text, /FAIL .*broken\.test\.ts/)
    await expectGolden('summary.threshold', text)
  })

  test('does not reprint the failures when the run is no bigger than the threshold', async () => {
    const { text } = await playFixture((out) =>
      summaryReporter({ stream: out, ...PLAIN, failureSummaryThreshold: 100 }),
    )
    assert.doesNotMatch(text, /Summary of all failing tests/)
  })

  test('takes the snapshot summary and the closing line from its caller, and none under silent', async () => {
    const options = {
      stream: undefined as never,
      ...PLAIN,
      snapshotSummary: () => ['Snapshot Summary', ' › 1 snapshot failed'],
      closingLine: () => 'Ran all test suites.',
    }
    const loud = await playFixture((out) => summaryReporter({ ...options, stream: out }))
    assert.match(loud.text, /Snapshot Summary\n › 1 snapshot failed\n\nTest Suites:/)
    assert.match(loud.text, /Time: .*\nRan all test suites\.\n$/)
    const quiet = await playFixture((out) =>
      summaryReporter({ ...options, stream: out, silent: true }),
    )
    assert.doesNotMatch(quiet.text, /Ran all test suites/)
  })

  test('says "Snapshots:   0 total" only when asked, since Provino leaves the line out of a run with none', async () => {
    const without = await playThrough(
      (out) => summaryReporter({ stream: out, ...PLAIN }),
      FIXTURE_FILES,
    )
    assert.doesNotMatch(without, /Snapshots:/)
    const always = await playThrough(
      (out) => summaryReporter({ stream: out, ...PLAIN, snapshotsAlways: true }),
      FIXTURE_FILES,
    )
    assert.match(always, /Snapshots: {3}0 total/)
  })
})

describe('the text reporters beside the summary reporter', () => {
  test('summary: false leaves the totals out and keeps the files', async () => {
    const { text } = await playFixture((out) =>
      defaultReporter({ stream: out, ...PLAIN, summary: false }),
    )
    assert.match(text, /FAIL .*broken\.test\.ts/)
    assert.doesNotMatch(text, /Test Suites:|Tests:|Time:/)
  })

  test('default with summary: false followed by the summary reporter prints what default alone prints', async () => {
    const both = await playFixture((out) =>
      together(
        defaultReporter({ stream: out, ...PLAIN, summary: false }),
        summaryReporter({ stream: out, ...PLAIN }),
      ),
    )
    const alone = await playFixture((out) => defaultReporter({ stream: out, ...PLAIN }))
    assert.equal(both.text, alone.text)
  })

  test('failureText is printed in place of the failure blocks of a failed file', async () => {
    const { text } = await playFixture((out) =>
      defaultReporter({
        stream: out,
        ...PLAIN,
        failureText: (file) =>
          file.state === 'fail' ? `JEST TEXT FOR ${file.file.path}\n` : undefined,
      }),
    )
    assert.match(text, /JEST TEXT FOR .*broken\.test\.ts/)
    assert.doesNotMatch(text, /group › fails\n/)
  })
})
