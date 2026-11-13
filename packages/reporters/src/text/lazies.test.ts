// T6.10: a failed test's lazy values in the text reporters. Their own goldens
// (`__goldens__/lazies.{plain,tty}.txt`): the fixture run's goldens don't change.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { LazyEvaluation, SerializedError } from '@provino/types'
import { agentReporter } from '../agent/reporter.ts'
import { defaultReporter } from '../default/reporter.ts'
import { dotReporter } from '../dot/reporter.ts'
import { expectGolden } from '../internal/golden.ts'
import {
  type FileSpec,
  fileInfo,
  JEST_REPORT,
  playThrough,
  taskId,
} from '../internal/test-support.ts'
import { createStyle } from '../style.ts'
import { verboseReporter } from '../verbose/reporter.ts'
import { lazyBlock } from './format.ts'

const FILE = '/project/src/cart.test.ts'

const error: SerializedError = {
  name: 'Error',
  message: 'no such user',
  stack: 'Error: no such user\n    at user (/project/src/cart.test.ts:5:30)',
}

const lazies: readonly LazyEvaluation[] = [
  { key: 'db', site: { file: FILE, line: 3, column: 14 }, override: false, ms: 0.2, failed: false },
  {
    key: 'user',
    site: { file: FILE, line: 5, column: 14 },
    override: true,
    ms: 3.4,
    failed: true,
    chain: ['cart', 'user'],
  },
  {
    key: 'cart',
    site: { file: FILE, line: 6, column: 14 },
    override: false,
    ms: 12.6,
    failed: true,
    chain: ['cart', 'user'],
  },
]

const FILES: readonly FileSpec[] = [
  {
    path: 'src/cart.test.ts',
    tests: [
      { path: ['cart', 'totals'], state: 'fail', errors: [error], lazies },
      { path: ['cart', 'plain'], state: 'fail', errors: [error] },
      { path: ['cart', 'fine'], state: 'pass' },
    ],
  },
]

const MODES = {
  plain: { colour: false, live: false, columns: 80 },
  tty: { colour: true, live: true, columns: 80 },
} as const

describe('lazy values in the failure report', () => {
  for (const [mode, options] of Object.entries(MODES)) {
    test(`default, ${mode}`, async () => {
      const text = await playThrough(
        (out) => defaultReporter({ stream: out, report: JEST_REPORT, ...options }),
        FILES,
      )
      await expectGolden(`lazies.${mode}`, text)
    })
  }

  test('every text reporter prints the block under the failed test, and only there', async () => {
    for (const make of [defaultReporter, verboseReporter, agentReporter, dotReporter]) {
      const text = await playThrough(
        (out) =>
          make({ stream: out, report: JEST_REPORT, colour: false, live: false, columns: 80 }),
        FILES,
      )
      assert.equal(text.split('Lazy values evaluated before the failure:').length, 2)
      assert.match(text, /chain: cart -> user/)
      assert.equal(text.match(/chain: /g)?.length, 1)
    }
  })

  test('a site outside the project root keeps its whole path', () => {
    const block = lazyBlock(
      [
        {
          key: 'x',
          site: { file: '/elsewhere/a.ts', line: 1, column: 2 },
          override: false,
          ms: 1,
          failed: false,
        },
      ],
      '/project',
      createStyle(false),
    )
    assert.match(block, /\/elsewhere\/a\.ts:1:2/)
  })

  test('no values is no block', () => {
    assert.equal(lazyBlock(undefined, '/project', createStyle(false)), '')
    assert.equal(lazyBlock([], '/project', createStyle(false)), '')
  })

  // A dialect's own failure text (Jest's, under `provino jest`) comes in one block per failed
  // test, so each test's values go under its own block, and with none the text is the blocks
  // joined as the dialect wrote them.
  test("under a dialect's failure text, each test's values follow that test's block", async () => {
    const fileId = fileInfo('src/cart.test.ts').fileId
    const blocks = [
      { taskId: taskId(`${fileId}/t0`), text: '  ● cart › totals\n\n    DIALECT TEXT A\n' },
      { taskId: taskId(`${fileId}/t1`), text: '  ● cart › plain\n\n    DIALECT TEXT B\n' },
      { text: '\n  FILE ERRORS\n' },
    ]
    const text = await playThrough(
      (out) =>
        defaultReporter({
          stream: out,
          report: JEST_REPORT,
          colour: false,
          live: false,
          columns: 80,
          failureText: (file) => (file.state === 'fail' ? blocks : undefined),
        }),
      FILES,
    )
    const a = text.indexOf('DIALECT TEXT A')
    const lazy = text.indexOf('Lazy values evaluated before the failure:')
    const b = text.indexOf('DIALECT TEXT B')
    assert.ok(a !== -1 && a < lazy && lazy < b, text)
    assert.equal(text.split('Lazy values evaluated before the failure:').length, 2, text)
    assert.ok(text.indexOf('FILE ERRORS') > b, text)
    assert.doesNotMatch(text, /no such user/)

    const plain = await playThrough(
      (out) =>
        defaultReporter({
          stream: out,
          report: JEST_REPORT,
          colour: false,
          live: false,
          columns: 80,
          failureText: (file) => (file.state === 'fail' ? blocks.slice(1) : undefined),
        }),
      FILES,
    )
    assert.ok(
      plain.includes(
        blocks
          .slice(1)
          .map((block) => block.text)
          .join('\n'),
      ),
      plain,
    )
  })
})
