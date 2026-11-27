// The wait of the paced replay (`slow-sink` leg): a batch is never sent before its due time.

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
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  yieldTurn: () => new Promise<void>((resolve) => setImmediate(resolve)),
}

/**
 * Waits until `clock.now() >= due`, yielding at least one turn so timers (the frame timer) fire.
 * A timer can fire early (it truncates a fractional delay and reads libuv's cached loop time), so
 * the clock is read again after each wait; the last sub-millisecond is spent in loop turns.
 */
export async function waitUntil(due: number, clock: PaceClock): Promise<void> {
  let yielded = false
  for (;;) {
    const delay = due - clock.now()
    if (delay <= 0 && yielded) return
    if (delay > 1) await clock.sleep(Math.ceil(delay))
    else await clock.yieldTurn()
    yielded = true
  }
}
