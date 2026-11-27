import { describe, expect, it } from 'provino'
import { type PaceClock, waitUntil } from './pace.ts'

/** A clock the test moves: a timer fires `earlyMs` before it was asked to (but never in under 1 ms), a turn costs 0.2 ms. */
function fakeClock(earlyMs: number): PaceClock & { time: number } {
  const clock = {
    time: 0,
    now: () => clock.time,
    sleep(ms: number) {
      clock.time += Math.max(1, Math.floor(ms) - earlyMs)
      return Promise.resolve()
    },
    yieldTurn() {
      clock.time += 0.2
      return Promise.resolve()
    },
  }
  return clock
}

describe('waitUntil', () => {
  it('returns at or after the due time when a timer fires early', async () => {
    const clock = fakeClock(1)
    await waitUntil(25.5, clock)
    expect(clock.time).toBeGreaterThanOrEqual(25.5)
  })

  it('returns at or after the due time when the due time is under a millisecond away', async () => {
    const clock = fakeClock(0)
    clock.time = 10
    await waitUntil(10.7, clock)
    expect(clock.time).toBeGreaterThanOrEqual(10.7)
  })

  it('still yields one turn when the due time has passed', async () => {
    const clock = fakeClock(0)
    clock.time = 50
    await waitUntil(40, clock)
    expect(clock.time).toBeCloseTo(50.2)
  })

  it('sleeps no further once a late timer has passed the due time', async () => {
    const clock = fakeClock(-5)
    await waitUntil(25.5, clock)
    expect(clock.time).toBeCloseTo(30)
  })

  it('adds no overshoot when the timer fires on time', async () => {
    const clock = fakeClock(0)
    await waitUntil(25.5, clock)
    expect(clock.time).toBeGreaterThanOrEqual(25.5)
    expect(clock.time).toBeLessThan(26)
  })
})
