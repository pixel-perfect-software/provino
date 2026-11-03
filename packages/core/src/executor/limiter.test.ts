// The `maxConcurrency` semaphore. Calls are held open with explicit promises, never timers.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { settle } from '../internal/test-support.ts'
import { createLimiter, unlimited } from './limiter.ts'

/** A call the test finishes by hand: it records when it starts. */
function held(started: string[], name: string): { fn: () => Promise<string>; release: () => void } {
  const gate = Promise.withResolvers<void>()
  return {
    fn: async () => {
      started.push(name)
      await gate.promise
      return name
    },
    release: () => gate.resolve(),
  }
}

describe('createLimiter', () => {
  test('runs at most max calls at once, the rest wait in the order they asked', async () => {
    const limiter = createLimiter(2)
    const started: string[] = []
    const calls = ['a', 'b', 'c', 'd'].map((name) => held(started, name))
    const results = calls.map((call) => limiter.run(call.fn))
    await settle()
    assert.deepEqual(started, ['a', 'b'])
    assert.equal(limiter.active, 2)

    calls[0]?.release()
    await settle()
    assert.deepEqual(started, ['a', 'b', 'c'])
    assert.equal(limiter.active, 2)

    calls[1]?.release()
    calls[2]?.release()
    calls[3]?.release()
    assert.deepEqual(await Promise.all(results), ['a', 'b', 'c', 'd'])
    assert.deepEqual(started, ['a', 'b', 'c', 'd'])
    assert.equal(limiter.active, 0)
  })

  test('returns what the call returned', async () => {
    assert.equal(await createLimiter(1).run(async () => 42), 42)
  })

  test('a call that rejects gives its slot to the next one, and its error to the caller', async () => {
    const limiter = createLimiter(1)
    const started: string[] = []
    const next = held(started, 'next')
    const failing = limiter.run(async () => {
      throw new Error('boom')
    })
    const waiting = limiter.run(next.fn)
    await assert.rejects(failing, /boom/)
    await settle()
    assert.deepEqual(started, ['next'])
    next.release()
    await waiting
    assert.equal(limiter.active, 0)
  })

  test('active never goes above max, and is zero when idle', async () => {
    const limiter = createLimiter(3)
    let peak = 0
    const results = Array.from({ length: 10 }, (_, index) =>
      limiter.run(async () => {
        peak = Math.max(peak, limiter.active)
        await Promise.resolve()
        return index
      }),
    )
    await Promise.all(results)
    assert.equal(peak, 3)
    assert.equal(limiter.active, 0)
  })

  test('a fractional max is rounded down', async () => {
    const limiter = createLimiter(2.9)
    const started: string[] = []
    const calls = ['a', 'b', 'c'].map((name) => held(started, name))
    const results = calls.map((call) => limiter.run(call.fn))
    await settle()
    assert.deepEqual(started, ['a', 'b'])
    for (const call of calls) call.release()
    await Promise.all(results)
  })

  for (const max of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    test(`a max of ${max} means no limit`, async () => {
      const limiter = createLimiter(max)
      const started: string[] = []
      const calls = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => held(started, name))
      const results = calls.map((call) => limiter.run(call.fn))
      await settle()
      assert.equal(started.length, 6)
      for (const call of calls) call.release()
      await Promise.all(results)
    })
  }
})

describe('unlimited', () => {
  test('starts every call at once and returns its result', async () => {
    const started: string[] = []
    const calls = ['a', 'b', 'c'].map((name) => held(started, name))
    const results = calls.map((call) => unlimited.run(call.fn))
    await settle()
    assert.deepEqual(started, ['a', 'b', 'c'])
    for (const call of calls) call.release()
    assert.deepEqual(await Promise.all(results), ['a', 'b', 'c'])
  })
})
