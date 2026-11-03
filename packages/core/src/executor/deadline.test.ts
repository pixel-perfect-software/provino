// Real-timer deadlines, driven by a fake clock: the timer functions and `now` are injected, so
// nothing here waits on wall time.
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import FakeTimers, { type Clock } from '@sinonjs/fake-timers'
import { timersOf, watch } from '../internal/test-support.ts'
import { type DeadlineOptions, withDeadline } from './deadline.ts'

const TIMEOUT = new Error('timed out')

let clock: Clock
/** The injected `now`: moved by hand, apart from the timer clock. */
let elapsed = 0

beforeEach(() => {
  clock = FakeTimers.createClock(0)
  elapsed = 0
})

function options(overrides: Partial<DeadlineOptions> = {}): DeadlineOptions {
  return {
    timeoutMs: 100,
    catchSyncOverrun: false,
    timers: timersOf(clock),
    now: () => elapsed,
    timeoutError: () => TIMEOUT,
    ...overrides,
  }
}

describe('withDeadline settling', () => {
  test('resolves with a synchronous return value', async () => {
    assert.equal(await withDeadline(() => 'sync', options()), 'sync')
  })

  test('resolves with what a returned promise resolves to', async () => {
    assert.equal(await withDeadline(async () => 'async', options()), 'async')
  })

  test('rejects with a synchronous throw', async () => {
    await assert.rejects(
      withDeadline(() => {
        throw new Error('sync boom')
      }, options()),
      /sync boom/,
    )
  })

  test('rejects with what a returned promise rejects with', async () => {
    await assert.rejects(
      withDeadline(async () => {
        throw new Error('async boom')
      }, options()),
      /async boom/,
    )
  })

  test('waits for a thenable that is not a native promise', async () => {
    // biome-ignore lint/suspicious/noThenProperty: the point is a thenable that is not a Promise
    const thenable = { then: (resolve: (value: string) => void) => resolve('thenable') }
    assert.equal(await withDeadline(() => thenable, options()), 'thenable')
  })

  test('clears its timer once the call has settled', async () => {
    await withDeadline(async () => {}, options())
    assert.equal(clock.countTimers(), 0)
  })
})

describe('withDeadline timing out', () => {
  test('rejects with the timeout error once the time is up, and not before', async () => {
    const pending = withDeadline(() => new Promise(() => {}), options({ timeoutMs: 100 }))
    const state = watch(pending)
    pending.catch(() => {})
    await clock.tickAsync(99)
    assert.equal(state.settled, false)
    await clock.tickAsync(1)
    await assert.rejects(pending, (error) => error === TIMEOUT)
  })

  test('calls onTimeout once, with the timeout error', async () => {
    const seen: Error[] = []
    const pending = withDeadline(
      () => new Promise(() => {}),
      options({ onTimeout: (error) => seen.push(error) }),
    )
    pending.catch(() => {})
    await clock.tickAsync(100)
    assert.deepEqual(seen, [TIMEOUT])
  })

  test('does not call onTimeout when the call finishes in time', async () => {
    const seen: Error[] = []
    await withDeadline(async () => {}, options({ onTimeout: (error) => seen.push(error) }))
    await clock.tickAsync(1000)
    assert.deepEqual(seen, [])
  })

  test('ignores a result that arrives after the timeout', async () => {
    const late = Promise.withResolvers<string>()
    const pending = withDeadline(() => late.promise, options())
    pending.catch(() => {})
    await clock.tickAsync(100)
    late.resolve('too late')
    await assert.rejects(pending, (error) => error === TIMEOUT)
  })

  test('ignores an error that arrives after the timeout', async () => {
    const late = Promise.withResolvers<string>()
    const pending = withDeadline(() => late.promise, options())
    pending.catch(() => {})
    await clock.tickAsync(100)
    late.reject(new Error('too late'))
    await assert.rejects(pending, (error) => error === TIMEOUT)
  })

  for (const timeoutMs of [0, Number.POSITIVE_INFINITY]) {
    test(`a timeout of ${timeoutMs} sets no timer and never expires`, async () => {
      const late = Promise.withResolvers<string>()
      const pending = withDeadline(() => late.promise, options({ timeoutMs }))
      assert.equal(clock.countTimers(), 0)
      await clock.tickAsync(1_000_000)
      late.resolve('still fine')
      assert.equal(await pending, 'still fine')
    })
  }
})

describe('withDeadline and a synchronous overrun', () => {
  test('catchSyncOverrun fails a call that finished after the deadline had passed', async () => {
    const pending = withDeadline(
      () => {
        elapsed += 101
        return 'finished'
      },
      options({ catchSyncOverrun: true, timeoutMs: 100 }),
    )
    await assert.rejects(pending, (error) => error === TIMEOUT)
  })

  test('catchSyncOverrun calls onTimeout for it', async () => {
    const seen: Error[] = []
    const pending = withDeadline(
      () => {
        elapsed += 101
      },
      options({ catchSyncOverrun: true, onTimeout: (error) => seen.push(error) }),
    )
    await assert.rejects(pending)
    assert.deepEqual(seen, [TIMEOUT])
  })

  test('catchSyncOverrun lets a call that took exactly the timeout pass', async () => {
    const pending = withDeadline(
      () => {
        elapsed += 100
        return 'in time'
      },
      options({ catchSyncOverrun: true, timeoutMs: 100 }),
    )
    assert.equal(await pending, 'in time')
  })

  test('catchSyncOverrun also fails a promise that resolves after the deadline had passed', async () => {
    const pending = withDeadline(
      async () => {
        elapsed += 101
      },
      options({ catchSyncOverrun: true }),
    )
    await assert.rejects(pending, (error) => error === TIMEOUT)
  })

  test('catchSyncOverrun fails a call that threw after the deadline had passed, with the timeout error', async () => {
    const pending = withDeadline(
      () => {
        elapsed += 101
        throw new Error('own error')
      },
      options({ catchSyncOverrun: true }),
    )
    await assert.rejects(pending, (error) => error === TIMEOUT)
  })

  test('without catchSyncOverrun the same call passes', async () => {
    const pending = withDeadline(
      () => {
        elapsed += 101
        return 'finished'
      },
      options({ catchSyncOverrun: false }),
    )
    assert.equal(await pending, 'finished')
  })

  test('catchSyncOverrun does nothing for a call with no deadline', async () => {
    const pending = withDeadline(
      () => {
        elapsed += 1_000_000
        return 'finished'
      },
      options({ catchSyncOverrun: true, timeoutMs: 0 }),
    )
    assert.equal(await pending, 'finished')
  })
})
