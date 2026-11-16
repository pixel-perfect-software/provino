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
import { requireFromJest } from './internal/test-support.ts'
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
    'the runner clears a retried attempt by its test id (`clearTest`); a matcher has no test id to give',
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

/** What the view asked the state underneath. */
type Call =
  | readonly ['match', SnapshotViewMatchOptions]
  | readonly ['fail', string, string | undefined, string | undefined]
  | readonly ['markCheckedForTest', string]

/** A state with nothing behind it but its fields, which records the calls made to it. */
function source(update: SnapshotViewSource['update'] = 'new') {
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
    format: Object.freeze({ escapeString: false, printBasicPrototype: false }),
    match(options) {
      calls.push(['match', options])
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
    assert.equal(view.snapshotFormat, state.format, 'one object for the file')
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
      ['match', { testName: 't: hint', received: { a: 1 }, isInline: false, testFailing: false }],
    ])
  })

  test('match passes a key on, and an inline call`s stack', () => {
    const { state, calls } = source()
    const view = jestSnapshotStateView(state)
    view.match({ testName: 't', received: 1, isInline: false, key: 'mine' })
    const error = new Error('at the call')
    view.match({ testName: 't', received: 1, isInline: true, inlineSnapshot: '1', error })
    assert.deepEqual(calls, [
      ['match', { testName: 't', received: 1, isInline: false, key: 'mine' }],
      [
        'match',
        { testName: 't', received: 1, isInline: true, inlineSnapshot: '1', stack: error.stack },
      ],
    ])
  })

  test('an inline match with no error takes the stack below the matcher trap', () => {
    const { state, calls } = source()
    const view = jestSnapshotStateView(state)
    // The engine's `throwingMatcher` calls a custom matcher inside a frame of the trap's name
    // (`@provino/expect`'s `expect.ts`), as Jest's does: the user's call is the frame below both.
    function throwingMatcher() {
      ;(function __EXTERNAL_MATCHER_TRAP__() {
        view.match({ testName: 't', received: 1, isInline: true })
      })()
    }
    function usersCall() {
      throwingMatcher()
    }
    usersCall()
    const [call] = calls
    assert.ok(call !== undefined && call[0] === 'match')
    const stack = call[1].stack ?? ''
    assert.doesNotMatch(stack, /__EXTERNAL_MATCHER_TRAP__|inlineStack|throwingMatcher/)
    assert.match(stack.split('\n')[0] ?? '', /\busersCall\b.*snapshot-state-view\.test\.ts/)
  })

  test('fail, markSnapshotsAsCheckedForTest and the unchecked keys reach the state', () => {
    const { state, calls } = source()
    const view = jestSnapshotStateView(state)
    // As `_toMatchSnapshot` calls it when the property matchers fail (index.ts L344-L349).
    assert.equal(view.fail('u', { a: 1 }, undefined, {}), 'u 1')
    assert.equal(view.fail('u', { a: 1 }, 'u mine'), 'u 1')
    view.markSnapshotsAsCheckedForTest('v')
    assert.deepEqual(calls, [
      ['fail', 'u', undefined, undefined],
      ['fail', 'u', undefined, 'u mine'],
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
