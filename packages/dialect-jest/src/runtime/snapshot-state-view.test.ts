// `jestSnapshotStateView` (B23e, D128): Jest's `this.snapshotState` over Provino's state. Every
// public member of jest-snapshot 30.5.2's own `SnapshotState` (real jest-snapshot, reached
// through jest-config's install as the resolver's oracle is) is either on the view, of the same
// kind, or named in `NOT_CARRIED` with the reason; each one carried reads, writes or calls the
// state underneath. What jest-image-snapshot and jest-snapshot's own matchers do with it through
// `provino jest` is `provino`'s `ecosystem-image-snapshot.test.ts` and
// `ecosystem-custom-snapshot.test.ts`.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { createBehaviourLoader, resolvePolicy } from '@provino/policy'
import type {
  SnapshotViewMatchOptions,
  SnapshotViewMatchResult,
  SnapshotViewSource,
} from '@provino/types'
import { jestPolicy } from '../dialect.ts'
import { requireFromJest, setUpJestExpect } from './internal/test-support.ts'
import { jestSnapshotStateView } from './snapshot-state-view.ts'

const jestSnapshot = requireFromJest('jest-snapshot') as {
  SnapshotState: new (
    snapshotPath: string,
    options: { updateSnapshot: 'all' | 'new' | 'none'; snapshotFormat: object; rootDir: string },
  ) => object
}

/**
 * The members of jest-snapshot's `SnapshotState` the view leaves out, and why. Each is private in
 * jest-snapshot's types or belongs to the runner, which calls it once per file or per retry.
 */
const NOT_CARRIED: Readonly<Record<string, string>> = {
  constructor: 'not a member a matcher uses',
  save: 'the runner saves at the end of the file (`finish`); a matcher saving mid-file would write a half-checked file',
  clear:
    "the runner takes a retried attempt back itself (`clearTest`, by the test's id), and what a matcher takes through `match` and `fail` is the attempt's (`currentTestId`): a matcher clearing would take back its own test's other snapshots mid-attempt",
  removeUncheckedKeys: 'the runner removes obsolete snapshots at the end of the file',
  _dirty: 'private: whether the file must be written',
  _snapshotData: "private: the file's stored snapshots, which `match` reads",
  _snapshotPath: 'private: `snapshotPath` is carried',
  _inlineSnapshots: 'private: the inline edits, which go to the coordinator',
  _attemptRecordsByTest: 'private: what each attempt did, for `clear`',
  _writeCount: 'private: for `clear`',
  _uncheckedKeys: 'private: `getUncheckedKeys` is carried',
  _prettierPath: 'private: the coordinator formats inline snapshots',
  _rootDir: 'private: the coordinator writes inline snapshots',
  _addSnapshot: 'private: `match` writes',
  _recordFor: 'private: for `clear`',
  _markKeyChecked: 'private: `match` and `fail` check keys',
  _bumpCounter: 'private: `match` and `fail` count; `_counters` is carried',
  _incrementSnapshotCount: 'private: `match` and `fail` count; the four counts are carried',
}

const dir = mkdtempSync(join(tmpdir(), 'provino-snapshot-view-'))
after(() => rmSync(dir, { recursive: true, force: true }))

/** A match as the view asked it, its stack thunk called as the state would call it, in the call. */
type RecordedMatch = Omit<SnapshotViewMatchOptions, 'stack'> & { readonly stack?: string }

/** What the view asked the state underneath. */
type Call =
  | readonly ['match', RecordedMatch]
  | readonly ['fail', string, string | undefined, string | undefined]
  | readonly ['markCheckedForTest', string]

/**
 * A state with nothing behind it but its fields, which records the calls made to it. `running` is
 * the attempt its `currentTestId` names, as the worker's lookup would.
 */
function source(update: SnapshotViewSource['update'] = 'new', running = 'attempt-1') {
  const calls: Call[] = []
  const result: SnapshotViewMatchResult = {
    pass: false,
    count: 2,
    key: 't 2',
    actual: 'received',
    expected: 'stored',
  }
  const state: SnapshotViewSource = {
    added: 0,
    matched: 0,
    unmatched: 0,
    updated: 0,
    expand: false,
    update,
    liveCounters: new Map(),
    snapshotPath: join(dir, '__snapshots__', 'a.test.ts.snap'),
    serializeFormat: Object.freeze({ escapeString: false, printBasicPrototype: false }),
    currentTestId: () => running,
    match({ stack, ...options }) {
      // The options the view gave, without those it left `undefined`.
      const given = Object.fromEntries(
        Object.entries(options).filter(([, value]) => value !== undefined),
      ) as RecordedMatch
      calls.push(['match', stack === undefined ? given : { ...given, stack: stack() }])
      // Provino's result also says whether an inline snapshot could not be written.
      return Object.assign({ inlineNotWritten: false }, result)
    },
    fail(testName, testId, key) {
      calls.push(['fail', testName, testId, key])
      return 'u 1'
    },
    markCheckedForTest(testName) {
      calls.push(['markCheckedForTest', testName])
    },
    getUncheckedCount: () => 3,
    getUncheckedKeys: () => ['old 1', 'old 2', 'old 3'],
  }
  return { state, calls, result }
}

/** What kind of value a member holds, as far as a matcher reading it can tell. */
const kindOf = (value: unknown): string => (value instanceof Map ? 'Map' : typeof value)

/** Every member of a real jest-snapshot state: its own fields and its class's methods and getters. */
function jestMembers(state: object): string[] {
  return [
    ...Object.keys(state),
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(state) as object),
  ]
}

describe('jestSnapshotStateView', () => {
  test('carries every member of jest-snapshot`s SnapshotState, or names why not', () => {
    const jest = new jestSnapshot.SnapshotState(join(dir, 'members.snap'), {
      updateSnapshot: 'new',
      snapshotFormat: {},
      rootDir: dir,
    })
    const view = jestSnapshotStateView(source().state)
    const missing = jestMembers(jest).filter((name) => !(name in view) && !(name in NOT_CARRIED))
    assert.deepEqual(missing, [], 'members neither on the view nor in NOT_CARRIED')
    const stale = Object.keys(NOT_CARRIED).filter((name) => !jestMembers(jest).includes(name))
    assert.deepEqual(stale, [], 'NOT_CARRIED names members jest-snapshot no longer has')
    const both = Object.keys(view).filter((name) => name in NOT_CARRIED)
    assert.deepEqual(both, [], 'carried and listed as not carried')
  })

  test('each member it carries is one jest-snapshot`s state has, holding the same kind of value', () => {
    for (const update of ['all', 'new', 'none'] as const) {
      const jest = new jestSnapshot.SnapshotState(join(dir, `${update}.snap`), {
        updateSnapshot: update,
        snapshotFormat: {},
        rootDir: dir,
      })
      const view = jestSnapshotStateView(source(update).state)
      for (const member of Object.keys(view)) {
        assert.ok(member in jest, `jest-snapshot's state has no ${member}`)
        assert.equal(
          kindOf(Reflect.get(view, member)),
          kindOf(Reflect.get(jest, member)),
          `${member} (${update})`,
        )
      }
      assert.equal(view._updateSnapshot, Reflect.get(jest, '_updateSnapshot'))
    }
  })

  test('_counters is the state`s live map, so a count set through it numbers the next key', () => {
    const { state } = source()
    const view = jestSnapshotStateView(state)
    assert.equal(view._counters, state.liveCounters)
    view._counters.set('t', 2)
    assert.equal(state.liveCounters.get('t'), 2)
    state.liveCounters.set('u', 1)
    assert.equal(view._counters.get('u'), 1)
  })

  test('the four counts and expand read and write the state`s own', () => {
    // A write goes straight to the state's field and belongs to no attempt, so a retry keeps it
    // (`liveCounters` in `@provino/snapshot`'s `state.ts`; `ecosystem/image-snapshot-retry`).
    const { state } = source()
    const view = jestSnapshotStateView(state)
    // As jest-image-snapshot writes them: `merge(snapshotState, { added: snapshotState.added + 1 })`.
    Object.assign(view, { added: view.added + 1 })
    view.updated += 2
    view.matched += 3
    view.unmatched += 4
    assert.deepEqual([state.added, state.updated, state.matched, state.unmatched], [1, 2, 3, 4])
    state.added = 10
    assert.equal(view.added, 10)
    view.expand = true
    assert.equal(state.expand, true)
  })

  test('snapshotFormat and snapshotPath are the state`s', () => {
    const { state } = source()
    const view = jestSnapshotStateView(state)
    assert.equal(view.snapshotFormat, state.serializeFormat, 'one object for the file')
    assert.equal(view.snapshotPath, state.snapshotPath)
  })

  test('match takes Jest`s arguments and gives Jest`s result', () => {
    const { state, calls, result } = source()
    const view = jestSnapshotStateView(state)
    // As `_toMatchSnapshot` calls it (index.ts L376-L384).
    const matched = view.match({
      error: undefined,
      inlineSnapshot: undefined,
      isInline: false,
      received: { a: 1 },
      testFailing: false,
      testIdentity: {},
      testName: 't: hint',
    })
    assert.deepEqual(Object.keys(matched).toSorted(), [
      'actual',
      'count',
      'expected',
      'key',
      'pass',
    ])
    assert.deepEqual(matched, {
      actual: result.actual,
      count: result.count,
      expected: result.expected,
      key: result.key,
      pass: result.pass,
    })
    assert.deepEqual(calls, [
      [
        'match',
        {
          testName: 't: hint',
          testId: 'attempt-1',
          received: { a: 1 },
          isInline: false,
          testFailing: false,
        },
      ],
    ])
  })

  // jest-snapshot hands `match` and `fail` the matcher's `currentTestIdentity` (index.ts L294),
  // which Provino's matcher state lacks; the snapshot is the running attempt's all the same, so a
  // retry takes it back (`ecosystem/custom-snapshot-retry`).
  test('match and fail take the snapshot as the running attempt`s', () => {
    let running = 'attempt-1'
    const { state, calls } = source()
    state.currentTestId = () => running
    const view = jestSnapshotStateView(state)
    view.match({ testName: 't', received: 1, isInline: false, testIdentity: undefined })
    running = 'attempt-2'
    view.fail('t', 1, undefined, undefined)
    assert.deepEqual(calls, [
      ['match', { testName: 't', testId: 'attempt-1', received: 1, isInline: false }],
      ['fail', 't', 'attempt-2', undefined],
    ])
  })

  test('match passes a key on, and an inline call`s stack', () => {
    const { state, calls } = source()
    const view = jestSnapshotStateView(state)
    view.match({ testName: 't', received: 1, isInline: false, key: 'mine' })
    const error = new Error('at the call')
    view.match({ testName: 't', received: 1, isInline: true, inlineSnapshot: '1', error })
    assert.deepEqual(calls, [
      ['match', { testName: 't', testId: 'attempt-1', received: 1, isInline: false, key: 'mine' }],
      [
        'match',
        {
          testName: 't',
          testId: 'attempt-1',
          received: 1,
          isInline: true,
          inlineSnapshot: '1',
          stack: error.stack,
        },
      ],
    ])
  })

  // Through the real engine (`@provino/expect`'s frames, as the worker builds it), with Jest's
  // rule: the lines after the innermost external-matcher trap, then the engine's frames below it.
  test('an inline match with no error takes the stack below the innermost matcher trap', (t) => {
    const { state, calls } = source()
    const view = jestSnapshotStateView(state)
    const { expect } = setUpJestExpect(t)
    const pass = { pass: true, message: () => '' }
    expect.extend({
      viaView(received: unknown) {
        view.match({ testName: 't', received, isInline: true })
        return pass
      },
      // A custom matcher that calls another through `expect`: the inner call is in its body.
      nestedViaView(received: unknown) {
        ;(expect(received) as unknown as { viaView(): void }).viaView()
        return pass
      },
    })
    const loose = (value: unknown) => expect(value) as unknown as Record<string, () => void>
    function usersCall() {
      loose(1).viaView?.()
    }
    function usersNestedCall() {
      loose(1).nestedViaView?.()
    }
    usersCall()
    usersNestedCall()
    const firstFrames = calls.map((call) =>
      call[0] === 'match' ? (call[1].stack ?? '').split('\n')[0] : undefined,
    )
    assert.match(firstFrames[0] ?? '', /\busersCall\b.*snapshot-state-view\.test\.ts/)
    assert.match(firstFrames[1] ?? '', /\bnestedViaView\b.*snapshot-state-view\.test\.ts/)
    for (const call of calls) {
      assert.ok(call[0] === 'match')
      assert.doesNotMatch(
        call[1].stack?.split('\n')[0] ?? '',
        /__EXTERNAL_MATCHER_TRAP__|throwingMatcher/,
      )
    }
  })

  test('fail, markSnapshotsAsCheckedForTest and the unchecked keys reach the state', () => {
    const { state, calls } = source()
    const view = jestSnapshotStateView(state)
    // As `_toMatchSnapshot` calls it when the property matchers fail (index.ts L344-L349).
    assert.equal(view.fail('u', { a: 1 }, undefined, {}), 'u 1')
    assert.equal(view.fail('u', { a: 1 }, 'u mine'), 'u 1')
    view.markSnapshotsAsCheckedForTest('v')
    assert.deepEqual(calls, [
      ['fail', 'u', 'attempt-1', undefined],
      ['fail', 'u', 'attempt-1', 'u mine'],
      ['markCheckedForTest', 'v'],
    ])
    assert.equal(view.getUncheckedCount(), 3)
    assert.deepEqual(view.getUncheckedKeys(), ['old 1', 'old 2', 'old 3'])
  })

  test('_counters, _updateSnapshot, snapshotFormat and snapshotPath can`t be replaced', () => {
    const { state } = source('none')
    const view = jestSnapshotStateView(state)
    for (const member of ['_counters', '_updateSnapshot', 'snapshotFormat', 'snapshotPath']) {
      assert.equal(Reflect.set(view, member, null), false, member)
    }
    assert.equal(view._counters, state.liveCounters)
    assert.equal(view._updateSnapshot, 'none')
  })

  test('the policy`s contextView ref loads it', async () => {
    const ref = resolvePolicy(jestPolicy).snapshot.contextView
    assert.ok(ref !== null)
    assert.equal(await createBehaviourLoader().load(ref), jestSnapshotStateView)
  })
})
