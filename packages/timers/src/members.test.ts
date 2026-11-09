import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { TimersPolicy } from '@provino/types'
import { createFakeClock } from './clock.ts'
import { TimersError } from './errors.ts'
import { makeEnv, neutral } from './internal/test-support.ts'
import { createTimerMembers, type TimerMembers } from './members.ts'
import type { TimerMemberName } from './types.ts'

const lifecycle: TimersPolicy = { ...neutral, facadeReturns: 'lifecycle', notFaked: 'warn' }
const all: TimersPolicy = { ...neutral, facadeReturns: 'all' }

function build(policy: TimersPolicy): {
  facade: object
  members: TimerMembers
  env: typeof globalThis
} {
  const { env } = makeEnv()
  const facade = {}
  const fakeClock = createFakeClock(env, policy)
  const members = createTimerMembers(
    () => fakeClock,
    policy,
    () => facade,
  )
  return { facade, members, env }
}

const call = (members: TimerMembers, name: TimerMemberName, ...args: unknown[]): unknown =>
  (members[name] as (...args: unknown[]) => unknown)(...args)

describe('createTimerMembers', () => {
  test('lifecycle: only useFakeTimers, useRealTimers and setTimerTickMode return the facade', async () => {
    const { facade, members } = build(lifecycle)
    assert.equal(call(members, 'useFakeTimers'), facade)
    assert.equal(call(members, 'setTimerTickMode', { mode: 'manual' }), facade)
    assert.equal(call(members, 'advanceTimersByTime', 1), undefined)
    assert.equal(call(members, 'runAllTimers'), undefined)
    assert.equal(call(members, 'clearAllTimers'), undefined)
    assert.equal(await call(members, 'advanceTimersByTimeAsync', 1), undefined)
    assert.equal(await call(members, 'runAllTimersAsync'), undefined)
    assert.equal(call(members, 'useRealTimers'), facade)
  })

  test('all: every member that does something returns the facade, an async one resolving to it', async () => {
    const { facade, members } = build(all)
    assert.equal(call(members, 'useFakeTimers'), facade)
    assert.equal(call(members, 'advanceTimersByTime', 1), facade)
    assert.equal(call(members, 'runAllTimers'), facade)
    assert.equal(call(members, 'runOnlyPendingTimers'), facade)
    assert.equal(call(members, 'runAllTicks'), facade)
    assert.equal(call(members, 'advanceTimersToNextTimer'), facade)
    assert.equal(call(members, 'advanceTimersToNextFrame'), facade)
    assert.equal(call(members, 'clearAllTimers'), facade)
    assert.equal(call(members, 'setSystemTime', 5), facade)
    assert.equal(await call(members, 'advanceTimersByTimeAsync', 1), facade)
    assert.equal(await call(members, 'runAllTimersAsync'), facade)
    assert.equal(await call(members, 'runOnlyPendingTimersAsync'), facade)
    assert.equal(await call(members, 'advanceTimersToNextTimerAsync'), facade)
    assert.equal(call(members, 'useRealTimers'), facade)
  })

  test('the members that answer a question return the answer under both', () => {
    for (const policy of [lifecycle, all]) {
      const { members } = build(policy)
      call(members, 'useFakeTimers', { now: 50 })
      assert.equal(call(members, 'getTimerCount'), 0)
      assert.equal(call(members, 'now'), 50)
      assert.equal(call(members, 'isFakeTimers'), true)
      assert.equal((call(members, 'getMockedSystemTime') as Date).getTime(), 50)
      assert.equal(typeof call(members, 'getRealSystemTime'), 'number')
      call(members, 'useRealTimers')
      assert.equal(call(members, 'isFakeTimers'), false)
    }
  })

  test('setSystemTime takes a string as a date; setTimerTickMode takes Vitest`s strings', () => {
    const { members } = build(all)
    call(members, 'useFakeTimers')
    call(members, 'setSystemTime', '2024-02-03T04:05:06.000Z')
    assert.equal(call(members, 'now'), Date.parse('2024-02-03T04:05:06.000Z'))
    call(members, 'setTimerTickMode', 'manual')
    call(members, 'setTimerTickMode', 'nextTimerAsync')
    call(members, 'setTimerTickMode', 'interval', 25)
    assert.throws(
      () => call(members, 'setTimerTickMode', 'sideways'),
      (error) =>
        error instanceof TimersError &&
        error.code === 'TIMERS_INVALID_TICK_MODE' &&
        error.message === 'Invalid tick mode: sideways',
    )
    call(members, 'useRealTimers')
  })

  test('a member that needs fake timers follows notFaked', () => {
    const { members } = build(all)
    assert.throws(() => call(members, 'runAllTimers'), TimersError)
    const warned = build(lifecycle)
    assert.equal(call(warned.members, 'runAllTimers'), undefined)
  })
})
