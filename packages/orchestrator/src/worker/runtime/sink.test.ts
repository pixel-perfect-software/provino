import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { MatcherState, RuntimeEvent, TaskId, TaskResult } from '@provino/types'
import { assertionCountSink, type RunStates } from './sink.ts'

const id = (value: string): TaskId => value as TaskId
const result = (overrides: Partial<TaskResult> = {}): TaskResult => ({
  state: 'pass',
  durationMs: 1,
  startTime: 0,
  errors: [],
  retryErrors: [],
  attempts: 1,
  repeatIndex: 0,
  assertions: 0,
  passingAssertions: 0,
  ...overrides,
})
const attemptEnd = (testId: string, attempt: number, repeat = 0): RuntimeEvent => ({
  type: 'test-attempt-end',
  id: id(testId),
  attempt,
  repeat,
  state: 'pass',
  errors: [],
  willRetry: false,
  t: 0,
})
const testEnd = (testId: string, overrides: Partial<TaskResult> = {}): RuntimeEvent => ({
  type: 'test-end',
  id: id(testId),
  result: result(overrides),
  t: 0,
})
const counts = (assertionCalls: number, numPassingAsserts: number): MatcherState =>
  ({ assertionCalls, numPassingAsserts }) as MatcherState

/** A state source with `states` by `id/attempt/repeat`, recording what it was asked. */
function statesOf(states: Readonly<Record<string, MatcherState>>) {
  const asked: string[] = []
  const source: RunStates = {
    stateOf(testId, run) {
      const key = `${testId}/${run.attempt}/${run.repeat}`
      asked.push(key)
      return states[key]
    },
  }
  return { source, asked }
}

function collect(source: RunStates, events: readonly RuntimeEvent[]): RuntimeEvent[] {
  const out: RuntimeEvent[] = []
  const sink = assertionCountSink(source, { emit: (event) => void out.push(event) })
  for (const event of events) sink.emit(event)
  return out
}

describe('assertionCountSink', () => {
  it('fills a test’s counts from the state of its last attempt and repeat', () => {
    const { source, asked } = statesOf({
      'f_0/0/0': counts(5, 1),
      'f_0/1/0': counts(3, 2),
      'f_0/0/1': counts(7, 7),
      'f_0/1/1': counts(4, 3),
    })
    const [, , , , end] = collect(source, [
      attemptEnd('f_0', 0),
      attemptEnd('f_0', 1),
      attemptEnd('f_0', 0, 1),
      attemptEnd('f_0', 1, 1),
      testEnd('f_0'),
    ])
    assert.deepEqual(asked, ['f_0/1/1'])
    assert.equal(end?.type === 'test-end' && end.result.assertions, 4)
    assert.equal(end?.type === 'test-end' && end.result.passingAssertions, 3)
  })

  it('keeps every other field of the result and every other event untouched', () => {
    const { source } = statesOf({ 'f_0/0/0': counts(2, 2) })
    const failed = testEnd('f_0', { state: 'fail', durationMs: 12, attempts: 3, note: 'n' })
    const others: RuntimeEvent[] = [
      { type: 'test-start', id: id('f_0'), t: 1 },
      attemptEnd('f_0', 0),
      { type: 'suite-start', id: id('f_s'), t: 2 },
    ]
    const out = collect(source, [...others, failed])
    assert.deepEqual(out.slice(0, 3), others)
    assert.deepEqual(out[3], {
      ...failed,
      result: {
        ...result({ state: 'fail', durationMs: 12, attempts: 3, note: 'n' }),
        assertions: 2,
        passingAssertions: 2,
      },
    })
  })

  it('replaces counts the event already carried', () => {
    const { source } = statesOf({ 'f_0/0/0': counts(1, 1) })
    const out = collect(source, [
      attemptEnd('f_0', 0),
      testEnd('f_0', { assertions: 9, passingAssertions: 9 }),
    ])
    assert.equal(out[1]?.type === 'test-end' && out[1].result.assertions, 1)
  })

  it('gives 0 and 0 to a test with no attempt, or one that never asserted', () => {
    const { source, asked } = statesOf({})
    const out = collect(source, [
      testEnd('f_skipped'),
      attemptEnd('f_quiet', 0),
      testEnd('f_quiet'),
    ])
    assert.deepEqual(asked, ['f_quiet/0/0'], 'a test with no attempt asks nobody')
    for (const event of [out[0], out[2]]) {
      assert.equal(event?.type === 'test-end' && event.result.assertions, 0)
      assert.equal(event?.type === 'test-end' && event.result.passingAssertions, 0)
    }
  })

  it('forgets a test once it ends, so a later test with the same id starts clean', () => {
    const { source, asked } = statesOf({ 'f_0/2/0': counts(1, 1) })
    collect(source, [attemptEnd('f_0', 2), testEnd('f_0'), testEnd('f_0')])
    assert.deepEqual(asked, ['f_0/2/0'])
  })

  it('tracks tests that run at the same time apart', () => {
    const { source } = statesOf({ 'f_0/0/0': counts(1, 1), 'f_1/0/0': counts(2, 0) })
    const out = collect(source, [
      attemptEnd('f_0', 0),
      attemptEnd('f_1', 0),
      testEnd('f_1'),
      testEnd('f_0'),
    ])
    assert.deepEqual(
      out
        .filter((event) => event.type === 'test-end')
        .map((event) => [event.id, event.result.assertions]),
      [
        ['f_1', 2],
        ['f_0', 1],
      ],
    )
  })
})
