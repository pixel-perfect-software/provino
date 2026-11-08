import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { RuntimeEvent, TaskNode, TestTask } from '@provino/types'
import { trackSnapshots } from './lifecycle.ts'
import { put, snapText, stateIn, tempDir } from './test-support.ts'

function testTask(id: string, fullName: string[], expectFail = false): TestTask {
  return {
    id,
    type: 'test',
    fullName,
    dupIndex: 0,
    each: false,
    concurrent: false,
    expectFail,
    timeoutMs: 5000,
    retry: 0,
    repeats: 0,
  } as unknown as TestTask
}

const collected = (...tasks: TestTask[]): RuntimeEvent =>
  ({
    type: 'file-collect-end',
    fileId: 'f',
    tasks: tasks as TaskNode[],
    errors: [],
    t: 0,
  }) as unknown as RuntimeEvent
const ended = (id: string, state: 'pass' | 'fail' | 'skip' | 'todo'): RuntimeEvent =>
  ({ type: 'test-end', id, result: { state }, t: 0 }) as unknown as RuntimeEvent
const attemptStart = (id: string, attempt: number, repeat = 0): RuntimeEvent =>
  ({ type: 'test-attempt-start', id, attempt, repeat, t: 0 }) as unknown as RuntimeEvent

describe('trackSnapshots', () => {
  const stored = snapText({
    'a pass 1': '1',
    'a skipped 1': '2',
    'a failed 1': '3',
    'a todo 1': '4',
    'a gone 1': '5',
  })

  test("the snapshots of skipped, todo and failed tests are not obsolete; a deleted test's are", () => {
    const dir = tempDir()
    put(dir, '__snapshots__/a.test.ts.snap', stored)
    const state = stateIn(dir)
    const life = trackSnapshots(state, { keyJoin: ' ' })
    life.observe(
      collected(
        testTask('1', ['a', 'pass']),
        testTask('2', ['a', 'skipped']),
        testTask('3', ['a', 'failed']),
        testTask('4', ['a', 'todo']),
      ),
    )
    state.match({ testName: 'a pass', testId: '1', received: 1, isInline: false })
    life.observe(ended('1', 'pass'))
    life.observe(ended('2', 'skip'))
    life.observe(ended('3', 'fail'))
    life.observe(ended('4', 'todo'))
    const report = life.finish()
    assert.deepEqual(report.uncheckedKeys, ['a gone 1'])
    assert.equal(report.unchecked, 1)
  })

  test('a test.failing that passed keeps what it stored; a plain pass does not excuse an unchecked key', () => {
    const dir = tempDir()
    put(dir, '__snapshots__/a.test.ts.snap', snapText({ 'a 1': '1', 'b 1': '2' }))
    const state = stateIn(dir)
    const life = trackSnapshots(state, { keyJoin: ' ' })
    life.observe(collected(testTask('1', ['a'], true), testTask('2', ['b'])))
    life.observe(ended('1', 'pass'))
    life.observe(ended('2', 'pass'))
    assert.deepEqual(life.finish().uncheckedKeys, ['b 1'])
  })

  test('a test that never ended counts as not run', () => {
    const dir = tempDir()
    put(dir, '__snapshots__/a.test.ts.snap', snapText({ 'a 1': '1' }))
    const state = stateIn(dir)
    const life = trackSnapshots(state, { keyJoin: ' ' })
    life.observe(collected(testTask('1', ['a'])))
    assert.deepEqual(life.finish().uncheckedKeys, [])
  })

  test('a later attempt or repeat starts from what the first left; the first attempt takes nothing back', () => {
    const dir = tempDir()
    const state = stateIn(dir)
    const life = trackSnapshots(state, { keyJoin: ' ' })
    life.observe(collected(testTask('1', ['t'])))
    life.observe(attemptStart('1', 0))
    state.match({ testName: 't', testId: '1', received: 1, isInline: false })
    life.observe(attemptStart('1', 1))
    assert.equal(state.added, 0, 'the retry took the first attempt back')
    assert.equal(
      state.match({ testName: 't', testId: '1', received: 1, isInline: false }).key,
      't 1',
    )
    life.observe(attemptStart('1', 0, 1))
    assert.equal(state.added, 0, 'so does a repeat')
    state.match({ testName: 't', testId: '1', received: 1, isInline: false })
    life.observe(ended('1', 'pass'))
    const report = life.finish()
    assert.equal(report.added, 1)
    assert.match(readFileSync(join(dir, '__snapshots__', 'a.test.ts.snap'), 'utf8'), /t 1/)
  })

  test('the key join is the one the keys were made with', () => {
    const dir = tempDir()
    put(dir, '__snapshots__/a.test.ts.snap', snapText({ 'a > b 1': '1' }))
    const state = stateIn(dir)
    const life = trackSnapshots(state, { keyJoin: ' > ' })
    life.observe(collected(testTask('1', ['a', 'b'])))
    life.observe(ended('1', 'skip'))
    assert.deepEqual(life.finish().uncheckedKeys, [])
  })
})
