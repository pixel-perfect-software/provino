// expect.poll (T7.8). Time is a manual scheduler injected through `pollTimers`, so nothing here
// waits: a test moves the clock and lets the microtasks run.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ExpectStatic, PollAssertion } from '@provino/types'
import { ExpectError } from './errors.ts'
import { testEngine, testTask } from './internal/test-support.ts'
import type { PollTimers } from './poll.ts'

/** A scheduler the test drives: timers fire in due order when `move` passes their time. */
function manualClock(): {
  readonly timers: PollTimers
  readonly move: (ms: number) => Promise<void>
  readonly advanced: number[]
  readonly pending: () => number
} {
  let now = 0
  let nextId = 1
  const queue = new Map<number, { readonly at: number; readonly callback: () => void }>()
  const advanced: number[] = []
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
  return {
    advanced,
    pending: () => queue.size,
    timers: {
      setTimeout: (callback, ms) => {
        const id = nextId++
        queue.set(id, { at: now + ms, callback })
        return id
      },
      clearTimeout: (handle) => {
        queue.delete(handle as number)
      },
      advance: (ms) => {
        advanced.push(ms)
        return Promise.resolve()
      },
    },
    async move(ms) {
      const target = now + ms
      for (;;) {
        await flush()
        const due = [...queue]
          .filter(([, timer]) => timer.at <= target)
          .sort(([, a], [, b]) => a.at - b.at)
        const first = due[0]
        if (first === undefined) break
        queue.delete(first[0])
        now = Math.max(now, first[1].at)
        first[1].callback()
      }
      now = target
      await flush()
    },
  }
}

const poll = (expect: ExpectStatic): NonNullable<ExpectStatic['poll']> => {
  assert.ok(expect.poll, 'expect.poll is there')
  return expect.poll
}

const POLICY = { poll: { enabled: true, intervalMs: 20, timeoutMs: 100 } }

/** Settles to `'pending'`, `'resolved'` or `'rejected'` without waiting. */
function watch(promise: PromiseLike<void>): { readonly state: () => string; error?: unknown } {
  const watched: { state: () => string; error?: unknown } = { state: () => 'pending' }
  promise.then(
    () => {
      watched.state = () => 'resolved'
    },
    (error: unknown) => {
      watched.state = () => 'rejected'
      watched.error = error
    },
  )
  return watched
}

describe('expect.poll', () => {
  test('exists only under ExpectPolicy.poll.enabled', () => {
    assert.equal(testEngine().expect.poll, undefined)
    assert.equal(typeof testEngine({ policy: POLICY }).expect.poll, 'function')
  })

  test('passes on its third call, one try per interval, and counts once', async () => {
    const clock = manualClock()
    const { expect, current, source } = testEngine({ policy: POLICY, pollTimers: clock.timers })
    current.enter(testTask('t'))
    let calls = 0
    const outcome = watch(poll(expect)(() => ++calls).toBe(3))
    await clock.move(0)
    assert.equal(calls, 1)
    await clock.move(20)
    assert.equal(calls, 2)
    assert.equal(outcome.state(), 'pending')
    await clock.move(20)
    assert.equal(calls, 3)
    assert.equal(outcome.state(), 'resolved')
    assert.equal(source.current().assertionCalls, 1)
    assert.equal(source.current().numPassingAsserts, 1)
    assert.equal(clock.pending(), 0, 'the timeout timer is cleared')
  })

  test('advances the fake clock by the interval after each wait', async () => {
    const clock = manualClock()
    const { expect, current } = testEngine({ policy: POLICY, pollTimers: clock.timers })
    current.enter(testTask('t'))
    let calls = 0
    const outcome = watch(poll(expect)(() => ++calls, { interval: 7 }).toBe(3))
    await clock.move(0)
    await clock.move(7)
    await clock.move(7)
    assert.equal(outcome.state(), 'resolved')
    assert.deepEqual(clock.advanced, [7, 7])
  })

  test('rejects after its timeout with the last matcher error, at the matcher call', async () => {
    const clock = manualClock()
    const { expect, current, source } = testEngine({ policy: POLICY, pollTimers: clock.timers })
    current.enter(testTask('t'))
    let signal: AbortSignal | undefined
    const outcome = watch(
      poll(expect)(
        (context) => {
          signal = context.signal
          return 'pending'
        },
        { interval: 20, timeout: 100 },
      ).toBe('done'),
    )
    await clock.move(99)
    assert.equal(outcome.state(), 'pending')
    assert.equal(signal?.aborted, false)
    await clock.move(1)
    assert.equal(outcome.state(), 'rejected')
    assert.equal(signal?.aborted, true)
    assert.ok(outcome.error instanceof Error)
    assert.equal(outcome.error.message, 'toBe: pending vs done')
    assert.match(String(outcome.error.stack).split('\n')[1] ?? '', /poll\.test\.ts/)
    assert.equal(source.current().numPassingAsserts, 0)
    assert.equal(clock.pending(), 0)
  })

  test('with pollFailsOnTimeout off, a timeout just ends', async () => {
    const clock = manualClock()
    const { expect, current } = testEngine({
      policy: { ...POLICY, pollFailsOnTimeout: false },
      pollTimers: clock.timers,
    })
    current.enter(testTask('t'))
    const outcome = watch(poll(expect)(() => 1, { timeout: 50 }).toBe(2))
    await clock.move(50)
    assert.equal(outcome.state(), 'resolved')
  })

  test('a callback that never settles times out with the table text', async () => {
    const clock = manualClock()
    const { expect, current } = testEngine({ policy: POLICY, pollTimers: clock.timers })
    current.enter(testTask('t'))
    const outcome = watch(poll(expect)(() => new Promise<never>(() => {}), { timeout: 40 }).toBe(1))
    await clock.move(40)
    assert.equal(outcome.state(), 'rejected')
    assert.equal((outcome.error as Error).message, 'poll function timed out')
  })

  test('a callback that throws is tried again', async () => {
    const clock = manualClock()
    const { expect, current } = testEngine({ policy: POLICY, pollTimers: clock.timers })
    current.enter(testTask('t'))
    let calls = 0
    const outcome = watch(
      poll(expect)(() => {
        if (++calls < 3) throw new Error('not yet')
        return 'ok'
      }).toBe('ok'),
    )
    await clock.move(0)
    await clock.move(20)
    await clock.move(20)
    assert.equal(outcome.state(), 'resolved')
    assert.equal(calls, 3)
  })

  test('.not retries until the matcher stops passing', async () => {
    const clock = manualClock()
    const { expect, current } = testEngine({ policy: POLICY, pollTimers: clock.timers })
    current.enter(testTask('t'))
    let calls = 0
    const outcome = watch(poll(expect)(() => ++calls).not.toBe(1))
    await clock.move(0)
    assert.equal(outcome.state(), 'pending', 'toBe(1) passes on the first call, so .not fails')
    await clock.move(20)
    assert.equal(outcome.state(), 'resolved')
  })

  test('options fall back to the policy, and bad input is refused', () => {
    const { expect, current } = testEngine({ policy: POLICY })
    current.enter(testTask('t'))
    const code = (fn: () => unknown): string | undefined => {
      try {
        fn()
      } catch (error) {
        return error instanceof ExpectError ? error.code : String(error)
      }
      return undefined
    }
    assert.equal(
      code(() => poll(expect)('nope' as never)),
      'EXPECT_INVALID_ARGUMENT',
    )
    assert.equal(
      code(() => poll(expect)(() => 1, { interval: -1 })),
      'EXPECT_INVALID_ARGUMENT',
    )
    assert.equal(
      code(() => poll(expect)(() => 1, { timeout: Number.NaN })),
      'EXPECT_INVALID_ARGUMENT',
    )
  })

  test('resolves, rejects and the throwing and snapshot matchers are refused', () => {
    const { expect, current } = testEngine({ policy: POLICY })
    current.enter(testTask('t'))
    const assertion = poll(expect)(() => 1) as unknown as Record<string, unknown>
    for (const name of ['resolves', 'rejects', 'toThrow', 'toMatchSnapshot']) {
      assert.throws(
        () => assertion[name],
        (error: unknown) =>
          error instanceof ExpectError &&
          error.code === 'EXPECT_POLL_UNSUPPORTED' &&
          error.message === `poll cannot use ${name}`,
      )
    }
    assert.equal(assertion.toBeFoo, undefined)
    assert.equal(assertion.then, undefined)
  })

  test('outside a test it throws EXPECT_OUTSIDE_TEST', () => {
    const { expect } = testEngine({ policy: POLICY })
    assert.throws(
      () => poll(expect)(() => 1),
      (error: unknown) => error instanceof ExpectError && error.code === 'EXPECT_OUTSIDE_TEST',
    )
  })

  test('uses a custom matcher like any other', async () => {
    const clock = manualClock()
    const { expect, current } = testEngine({ policy: POLICY, pollTimers: clock.timers })
    current.enter(testTask('t'))
    expect.extend({
      toBeEven(received: unknown) {
        return { pass: typeof received === 'number' && received % 2 === 0, message: () => 'odd' }
      },
    })
    let calls = 0
    const assertion = poll(expect)(() => ++calls) as PollAssertion & { toBeEven(): Promise<void> }
    const outcome = watch(assertion.toBeEven())
    await clock.move(0)
    await clock.move(20)
    assert.equal(outcome.state(), 'resolved')
  })
})

describe('an unawaited poll', () => {
  test('without tracking it starts at once, like an unawaited .resolves', async () => {
    const clock = manualClock()
    const { expect, current, source } = testEngine({ policy: POLICY, pollTimers: clock.timers })
    current.enter(testTask('t'))
    let calls = 0
    poll(expect)(() => ++calls).toBe(1)
    await clock.move(0)
    assert.equal(calls, 1)
    assert.equal(source.current().pendingAsync.size, 0)
  })

  test('with tracking it waits, is pending, and stops being pending when awaited', async () => {
    const clock = manualClock()
    const { expect, current, source } = testEngine({
      policy: POLICY,
      pollTimers: clock.timers,
      unawaited: 'fail',
    })
    current.enter(testTask('t'))
    let calls = 0
    const pending = poll(expect)(() => ++calls).toBe(1)
    await clock.move(0)
    assert.equal(calls, 0, 'nothing ran')
    const [entry] = [...source.current().pendingAsync]
    assert.equal(entry?.kind, 'poll')
    assert.deepEqual(entry?.call, { matcherName: 'toBe', isNot: false, promise: '' })
    assert.match(String(entry?.error.stack).split('\n')[1] ?? '', /poll\.test\.ts/)
    const outcome = watch(pending)
    assert.equal(source.current().pendingAsync.size, 0)
    await clock.move(0)
    assert.equal(calls, 1)
    assert.equal(outcome.state(), 'resolved')
  })
})
