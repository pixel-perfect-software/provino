import assert from 'node:assert/strict'
import { join } from 'node:path'
import { neutralPolicy } from '@provino/policy'
import { SnapshotError } from '@provino/snapshot'
import type { SnapshotViewFactory, SnapshotViewSource } from '@provino/types'
import { describe, test } from 'provino'
import { unwrapMatcherSnapshotState } from './matcher-state.ts'
import { openFileSnapshots } from './open.ts'
import { jsonPrinter, policy, tempDir } from './test-support.ts'

const snapshotPolicy = { ...neutralPolicy.snapshot, ...policy }
const key = (name: string, count: number): string => `${name} ${count}`

describe('openFileSnapshots', () => {
  test('puts the .snap beside the test file, in the policy`s directory and extension', () => {
    const dir = tempDir()
    const { state } = openFileSnapshots({
      testPath: join(dir, 'sub', 'a.test.ts'),
      update: 'none',
      expand: false,
      policy: { ...snapshotPolicy, dirName: '__snaps__', extension: '.out' },
      key,
      printer: jsonPrinter,
      resolvePath: null,
      contextView: null,
    })
    assert.equal(state.snapshotPath, join(dir, 'sub', '__snaps__', 'a.test.ts.out'))
  })

  test('asks the policy`s resolver, when it has one, with the extension', () => {
    const calls: unknown[] = []
    const { state } = openFileSnapshots({
      testPath: '/p/a.test.ts',
      update: 'none',
      expand: false,
      policy: snapshotPolicy,
      key,
      printer: jsonPrinter,
      resolvePath: (testPath, extension) => {
        calls.push([testPath, extension])
        return '/elsewhere/a.snap'
      },
      contextView: null,
    })
    assert.equal(state.snapshotPath, '/elsewhere/a.snap')
    assert.deepEqual(calls, [['/p/a.test.ts', '.snap']])
  })

  test('without a printer a file still opens, and its first snapshot fails with a code', () => {
    const { state } = openFileSnapshots({
      testPath: join(tempDir(), 'a.test.ts'),
      update: 'new',
      expand: false,
      policy: snapshotPolicy,
      key,
      printer: null,
      resolvePath: null,
      contextView: null,
    })
    assert.throws(
      () => state.match({ testName: 't', received: 1, isInline: false }),
      (error) => error instanceof SnapshotError && error.code === 'SNAPSHOT_NO_PRINTER',
    )
  })

  test('a file that never collected its tests reports nothing and writes nothing', () => {
    const { lifecycle } = openFileSnapshots({
      testPath: join(tempDir(), 'a.test.ts'),
      update: 'all',
      expand: false,
      policy: snapshotPolicy,
      key,
      printer: jsonPrinter,
      resolvePath: null,
      contextView: null,
    })
    assert.equal(lifecycle.finish(), null)
  })
})

describe('a matcher`s snapshotState (B23e, D128)', () => {
  const open = (contextView: SnapshotViewFactory | null) =>
    openFileSnapshots({
      testPath: join(tempDir(), 'a.test.ts'),
      update: 'new',
      expand: false,
      policy: snapshotPolicy,
      key,
      printer: jsonPrinter,
      resolvePath: null,
      contextView,
    })

  test('is the state itself with no view', () => {
    const opened = open(null)
    assert.equal(opened.matcherSnapshotState, opened.state)
    assert.equal(unwrapMatcherSnapshotState(opened.matcherSnapshotState), opened.state)
  })

  test('is the view the policy builds over the state, which unwraps to it', () => {
    const seen: SnapshotViewSource[] = []
    const opened = open((state) => {
      seen.push(state)
      return { shape: 'dialect' }
    })
    assert.deepEqual(seen, [opened.state], 'built once, over the file`s state')
    assert.deepEqual(
      Object.keys(opened.matcherSnapshotState),
      ['shape'],
      'the state is not an own key to see',
    )
    assert.equal(unwrapMatcherSnapshotState(opened.matcherSnapshotState), opened.state)
  })

  test('may be a frozen object, which is linked to the state without being written to', () => {
    const view = Object.freeze({ shape: 'frozen' })
    const opened = open(() => view)
    assert.equal(opened.matcherSnapshotState, view)
    assert.deepEqual(Reflect.ownKeys(view), ['shape'], 'nothing was defined on it')
    assert.equal(unwrapMatcherSnapshotState(opened.matcherSnapshotState), opened.state)
  })

  test('may be a function, which unwraps as an object does', () => {
    const view = Object.assign(() => {}, { shape: 'callable' })
    const opened = open(() => view)
    assert.equal(unwrapMatcherSnapshotState(view), opened.state)
  })

  test('a look-alike of a view is not one: only the object the factory built unwraps', () => {
    const opened = open(() => ({ shape: 'dialect' }))
    const copy = { ...opened.matcherSnapshotState }
    assert.equal(unwrapMatcherSnapshotState(copy), copy)
  })

  test('anything else unwraps to itself, so the matchers can refuse it', () => {
    for (const value of [undefined, null, 1, 'state', { match() {} }]) {
      assert.equal(unwrapMatcherSnapshotState(value), value)
    }
  })
})

describe('SnapshotState.testName', () => {
  const names = (keyJoin: string, hintJoin: string) =>
    openFileSnapshots({
      testPath: join(tempDir(), 'a.test.ts'),
      update: 'none',
      expand: false,
      policy: { ...snapshotPolicy, keyJoin, hintJoin },
      key,
      printer: jsonPrinter,
      resolvePath: null,
      contextView: null,
    }).state

  test('joins the title path with the key join and the hint with the hint join', () => {
    assert.equal(names(' ', ': ').testName(['a', 'b'], 'hint'), 'a b: hint')
    assert.equal(names(' > ', ' > ').testName(['a', 'b'], 'hint'), 'a > b > hint')
  })

  test('leaves an empty hint out, and a hint with no name', () => {
    assert.equal(names(' ', ': ').testName(['a'], ''), 'a')
    assert.equal(names(' ', ': ').testName(['a'], undefined), 'a')
    assert.equal(names(' ', ': ').testName([], 'hint'), '')
  })
})
