// Where a `done` settles its call's promise: with a turn clock (any `boundaryTurns` above 0) on the
// call itself, so the clock counts from where jest-circus's turns do; with none, a microtask later,
// as it always did, so the neutral path and Vitest's are unchanged.
import assert from 'node:assert/strict'
import { describe, test } from 'provino'
import { policyWith } from '../internal/test-support.ts'
import { type InvokeEnv, invoke } from './invoke.ts'

const policy = policyWith({ firstArg: 'done-if-arity' })

/** Calls a `done` function that calls `done` from a later turn; how many turns until its promise's `then` ran. */
async function turnsAfterDone(settleOnCall: boolean): Promise<number> {
  let done: (() => void) | undefined
  const env: InvokeEnv = {
    policy,
    format: String,
    over: () => false,
    late: () => undefined,
    settleOnCall,
  }
  const promise = invoke(env, {
    fn: ((callback: () => void) => {
      done = callback
    }) as never,
    arity: 1,
    thisArg: undefined,
    args: [],
    contextArgs: [],
    isTest: true,
  }) as Promise<void>
  let settled = false
  void promise.then(() => {
    settled = true
  })
  done?.()
  let turns = 0
  while (!settled && turns < 10) {
    await Promise.resolve()
    turns += 1
  }
  return turns
}

describe('a done callback called after the function returned', () => {
  test('settles the promise on the call with a turn clock, a microtask later without', async () => {
    const withClock = await turnsAfterDone(true)
    const without = await turnsAfterDone(false)
    assert.equal(without, withClock + 1)
  })
})
