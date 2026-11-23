// The two interactive modes (jest-core `FailedTestsInteractiveMode.ts`, `SnapshotInteractiveMode.ts`)
// over a fake terminal: what each key asks the driver to run and what each screen says. No process,
// no driver, no waits.
import assert from 'node:assert/strict'
import type { TextStyle } from '@provino/types'
import { describe, it } from 'provino'
import type { JestWatchTerminal } from './context.ts'
import {
  type JestAssertionLocation,
  JestFailedTestsInteractiveMode,
} from './failed-tests-interactive-mode.ts'
import type { JestWatchResults } from './hooks.ts'
import { jestWatchKeys } from './keys.ts'
import { JestSnapshotInteractiveMode } from './snapshot-interactive-mode.ts'
import { jestClearScreen, jestTerminalEscapes } from './terminal.ts'

const plain: TextStyle = {
  bold: (text) => text,
  dim: (text) => text,
  red: (text) => text,
  green: (text) => text,
  yellow: (text) => text,
  magenta: (text) => text,
  inverse: (text) => text,
  badge: (word) => word,
}
const CLEAR = jestClearScreen('linux')
const UP_ERASE = '\u001B[6A\u001B[J'
const ENTER = '\r'
const ESCAPE = '\u001B'

function terminal(): { readonly terminal: JestWatchTerminal; take(): string } {
  let text = ''
  return {
    terminal: {
      out: { write: (chunk) => (text += chunk) },
      style: plain,
      escapes: jestTerminalEscapes(false),
      clear: CLEAR,
      keys: jestWatchKeys('linux'),
    },
    take: () => {
      const taken = text
      text = ''
      return taken
    },
  }
}

const A: JestAssertionLocation = { fullName: 'a fails', path: '/root/a.test.ts' }
const B: JestAssertionLocation = { fullName: 'b fails', path: '/root/b.test.ts' }

function outcome(failed: number, snapshotFailure: boolean): JestWatchResults {
  return {
    numFailedTests: failed,
    snapshot: { failure: snapshotFailure, unmatched: snapshotFailure ? 1 : 0 },
    testResults: [],
  }
}

describe('FailedTestsInteractiveMode (L14-L195)', () => {
  it('runs the first failure, redraws over a run that still fails, s skips, q leaves', () => {
    const t = terminal()
    const mode = new JestFailedTestsInteractiveMode(t.terminal)
    const calls: (JestAssertionLocation | undefined)[] = []
    mode.run([A, B], (failure) => calls.push(failure))
    assert.equal(mode.isActive(), true)
    assert.deepEqual(calls, [A])
    mode.updateWithResults(outcome(1, false))
    assert.equal(
      t.take(),
      `${UP_ERASE}\nInteractive Test Progress\n › 2 tests remaining\n\n\nWatch Usage\n › Press s to skip the current test.\n › Press q to quit Interactive Mode.\n › Press Enter to return to watch mode.`,
    )
    mode.put('s')
    assert.deepEqual(calls, [A, B])
    mode.updateWithResults(outcome(1, false))
    assert.match(t.take(), / › 1 test remaining, 1 test skipped\n/)
    mode.put('q')
    assert.equal(mode.isActive(), false)
    assert.deepEqual(calls, [A, B, undefined])
  })

  it('a run that passes moves to the next; with none left, the done screen', () => {
    const t = terminal()
    const mode = new JestFailedTestsInteractiveMode(t.terminal)
    const calls: (JestAssertionLocation | undefined)[] = []
    mode.run([A, B], (failure) => calls.push(failure))
    mode.updateWithResults(outcome(0, false))
    assert.deepEqual(calls, [A, B])
    mode.updateWithResults(outcome(0, false))
    assert.equal(
      t.take(),
      `${CLEAR}Watch Usage\n › Press Enter to return to watch mode.\n`,
      'no test left: Enter returns',
    )
    mode.put(ENTER)
    assert.equal(mode.isActive(), false)
    assert.deepEqual(calls, [A, B, undefined])
  })

  it('skipping every failure draws the reviewed screen; r starts over', () => {
    const t = terminal()
    const mode = new JestFailedTestsInteractiveMode(t.terminal)
    const calls: (JestAssertionLocation | undefined)[] = []
    mode.run([A], (failure) => calls.push(failure))
    t.take()
    mode.put('s')
    assert.equal(
      t.take(),
      `${CLEAR}\nInteractive Test Progress\n › 1 test reviewed, 1 test skipped\n\n\nWatch Usage\n › Press r to restart Interactive Mode.\n › Press q to quit Interactive Mode.\n › Press Enter to return to watch mode.`,
    )
    mode.put('s')
    assert.deepEqual(calls, [A], 'nothing left to skip')
    mode.put('r')
    assert.deepEqual(calls, [A, A])
    mode.put(ESCAPE)
    assert.equal(mode.isActive(), false)
  })

  it('an empty list starts nothing', () => {
    const mode = new JestFailedTestsInteractiveMode(terminal().terminal)
    mode.run([], () => assert.fail('no run'))
    assert.equal(mode.isActive(), false)
  })
})

describe('SnapshotInteractiveMode (L16-L248)', () => {
  it('u updates the one shown, then the next runs alone; s skips the last to the result', () => {
    const t = terminal()
    const mode = new JestSnapshotInteractiveMode(t.terminal)
    const calls: [JestAssertionLocation | null, boolean][] = []
    mode.run([A, B], (assertion, update) => calls.push([assertion, update]))
    assert.deepEqual(calls, [[A, false]])
    mode.updateWithResults(outcome(1, true))
    assert.equal(
      t.take(),
      `${UP_ERASE}\nInteractive Snapshot Progress\n › 2 snapshots remaining\n\nWatch Usage\n › Press u to update failing snapshots for this test.\n › Press s to skip the current test.\n › Press q to quit Interactive Snapshot Mode.\n › Press Enter to trigger a test run.\n`,
    )
    mode.put('u')
    assert.deepEqual(calls.at(-1), [A, true])
    mode.updateWithResults(outcome(0, false))
    assert.deepEqual(calls.at(-1), [B, false], 'the next one runs by itself')
    mode.updateWithResults(outcome(1, true))
    assert.match(t.take(), / › 1 snapshot remaining, 1 snapshot updated\n/)
    mode.put('s')
    assert.equal(
      t.take(),
      `${CLEAR}\nInteractive Snapshot Result\n › 2 snapshots reviewed, 1 snapshot updated, 1 snapshot skipped\n\nWatch Usage\n › Press r to restart Interactive Snapshot Mode.\n › Press q to quit Interactive Snapshot Mode.\n`,
    )
    assert.equal(mode.getSkippedNum(), 1)
    mode.put('q')
    assert.equal(mode.isActive(), false)
    assert.deepEqual(calls.at(-1), [null, false])
  })

  it('with every snapshot updated, the done screen; Enter leaves', () => {
    const t = terminal()
    const mode = new JestSnapshotInteractiveMode(t.terminal)
    const calls: [JestAssertionLocation | null, boolean][] = []
    mode.run([A], (assertion, update) => calls.push([assertion, update]))
    mode.put('u')
    mode.updateWithResults(outcome(0, false))
    assert.equal(
      t.take(),
      `${CLEAR}\nInteractive Snapshot Result\n › 1 snapshot reviewed, 1 snapshot updated\n\nWatch Usage\n › Press Enter to return to watch mode.\n`,
    )
    mode.put(ENTER)
    assert.equal(mode.isActive(), false)
    assert.deepEqual(calls, [
      [A, false],
      [A, true],
      [null, false],
    ])
  })

  it('r restarts the count and runs the first again', () => {
    const t = terminal()
    const mode = new JestSnapshotInteractiveMode(t.terminal)
    const calls: [JestAssertionLocation | null, boolean][] = []
    mode.run([A, B], (assertion, update) => calls.push([assertion, update]))
    mode.put('s')
    mode.put('r')
    assert.equal(mode.getSkippedNum(), 0)
    assert.deepEqual(calls, [
      [A, false],
      [B, false],
      [B, false],
    ])
  })
})
