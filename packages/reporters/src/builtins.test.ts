// T9.7's goldens: each built-in reporter on the one fixture run (a pass, a failure, a skipped and a
// todo test, console output, a snapshot failure, a file that fails to collect), on a stream that is
// not a terminal and on one that is. The text reporters differ between the two (colour, the live
// block); `json`, `junit` and `github-actions` do not, and are held to the same bytes both ways.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Reporter, ReportPolicy } from '@provino/types'
import { agentReporter } from './agent/reporter.ts'
import { defaultReporter } from './default/reporter.ts'
import { dotReporter } from './dot/reporter.ts'
import { githubActionsReporter } from './github-actions/reporter.ts'
import { expectGolden } from './internal/golden.ts'
import { FIXED_ENV, type Output, playFixture } from './internal/test-support.ts'
import { junitReporter } from './junit/reporter.ts'
import { jsonReporter, normalizedJsonReporter } from './normalized-json/reporter.ts'
import type { TextReporterOptions } from './text/reporter.ts'
import { verboseReporter } from './verbose/reporter.ts'

/** Jest's values for the `report` slice (the `policy/report-default` golden). */
const REPORT: ReportPolicy = {
  displaySeparator: ' › ',
  defaultReporters: ['default'],
  failureTitleBullet: '  ● ',
  resultStatusSkipped: 'pending',
}

/** The text reporters' two modes: a pipe or a file, and a colour terminal. */
const MODES = {
  plain: { colour: false, live: false, columns: 80 },
  tty: { colour: true, live: true, columns: 80 },
} as const

const TEXT: readonly [string, (options: TextReporterOptions) => Reporter][] = [
  ['default', defaultReporter],
  ['verbose', verboseReporter],
  ['dot', dotReporter],
  ['agent', agentReporter],
]

describe('the text reporters on the fixture run', () => {
  for (const [name, make] of TEXT) {
    for (const [mode, options] of Object.entries(MODES)) {
      test(`${name}, ${mode}`, async () => {
        const { text } = await playFixture((out) =>
          make({ stream: out, report: REPORT, ...options }),
        )
        await expectGolden(`${name}.${mode}`, text)
      })
    }
  }

  test('none of them writes an escape character without colour', async () => {
    for (const [, make] of TEXT) {
      const { text } = await playFixture((out) =>
        make({ stream: out, report: REPORT, ...MODES.plain }),
      )
      assert.doesNotMatch(text, new RegExp(String.fromCharCode(27)))
    }
  })

  test('the agent reporter is the shortest, and holds every failure', async () => {
    const lengths = new Map<string, number>()
    for (const [name, make] of TEXT) {
      const { text } = await playFixture((out) =>
        make({ stream: out, report: REPORT, ...MODES.plain }),
      )
      lengths.set(name, text.length)
      if (name === 'agent' || name === 'dot') {
        for (const failure of ['group › fails', 'matches a stored snapshot', 'broken.test.ts']) {
          assert.ok(text.includes(failure), `${name} names ${failure}`)
        }
      }
    }
    const agent = lengths.get('agent') ?? 0
    for (const [name, length] of lengths) {
      if (name !== 'agent') assert.ok(agent < length, `agent (${agent}) is shorter than ${name}`)
    }
  })
})

describe('the file reporters on the fixture run', () => {
  const NOW = Date.UTC(2026, 10, 13, 9, 0, 0)

  test('json is the NormalizedRun document, and normalized-json is the same reporter', async () => {
    const options = (out: Output) => ({
      stream: out,
      suite: 'fixture',
      runner: 'provino:jest',
      runnerVersion: '0.0.0',
      env: FIXED_ENV,
      now: () => NOW,
    })
    const json = await playFixture((out) => jsonReporter(options(out)))
    const alias = await playFixture((out) => normalizedJsonReporter(options(out)))
    assert.equal(json.text, alias.text)
    assert.equal(jsonReporter(options({ write: () => undefined, text: () => '' })).name, 'json')
    await expectGolden('json', json.text, 'json')
  })

  test('junit', async () => {
    const { text } = await playFixture((out) =>
      junitReporter({ stream: out, report: REPORT, now: () => NOW }),
    )
    await expectGolden('junit', text, 'xml')
  })

  test('github-actions', async () => {
    const { text } = await playFixture((out) =>
      githubActionsReporter({ stream: out, report: REPORT }),
    )
    await expectGolden('github-actions', text)
  })
})
