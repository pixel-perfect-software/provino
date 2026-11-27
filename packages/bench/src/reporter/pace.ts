// The wait of the paced replay (`slow-sink` leg): a batch is never sent before its due time.

import { setImmediate as nextTurn, setTimeout as sleepFor } from 'node:timers/promises'

/** The clock and timers the paced replay waits with; the leg gives the real ones. */
export interface PaceClock {
  now(): number
  /** Resolves after about `ms`: a timer may fire a little early. */
  sleep(ms: number): Promise<void>
  /** Resolves on the next turn of the event loop. */
  yieldTurn(): Promise<void>
}

/** The real clock and timers. */
export const realPaceClock: PaceClock = {
  now: () => performance.now(),
  sleep: (ms) => sleepFor(ms),
  yieldTurn: () => nextTurn(),
}

/**
 * Waits until `clock.now() >= due`, yielding at least one turn so timers (the frame timer) fire.
 * A timer can fire early (it truncates a fractional delay and reads libuv's cached loop time), so
 * the clock is read again after each wait. It sleeps the whole milliseconds of the delay, never
 * rounding up, so an on-time timer adds no overshoot; the last sub-millisecond is spun in loop
 * turns, bounded and before the timed delivery.
 */
export async function waitUntil(due: number, clock: PaceClock): Promise<void> {
  let delay = due - clock.now()
  do {
    if (delay >= 1) await clock.sleep(Math.floor(delay))
    else await clock.yieldTurn()
    delay = due - clock.now()
  } while (delay > 0)
}
