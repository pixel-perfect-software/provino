import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { neutralPolicy } from '@provino/policy'
import { SnapshotError } from '@provino/snapshot'
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
    })
    assert.equal(lifecycle.finish(), null)
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
