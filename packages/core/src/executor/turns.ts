// The microtask turns a run gives the promise chains a file left running between two of its
// functions (`CorePolicy.boundaryTurns`). jest-circus awaits its event handlers at every event it
// dispatches, so a chain a test starts (an axios interceptor chain, a React state update) gets 20
// turns before the test's `afterEach` runs; core's own code takes 2 or 3. The clock counts the
// turns from the end of one function and holds the next one back until the boundaries passed on
// the way are paid for. It counts, rather than adding a fixed number of `await`s at each boundary,
// so the sum holds whatever core's own code takes between the two (a worker's try-task listeners,
// a lifecycle listener, a describe level, a limiter), as long as that is less.
//
// A function ends where jest-circus sees it end: on its return or throw, or on the turn after the
// promise it returned settled (circus's `returnedValue.then(...)`). The clock is started there, in
// the call itself (`through`), not where core's own code resumes after it.
//
// One turn is one microtask job: the clock queues its next turn behind every job queued before it,
// so a chain started before the function ended moves one hop per turn of the clock. A turn is a
// `then` on a resolved promise (about 20 ns), not `queueMicrotask`, which makes an `AsyncResource`
// for each call (about 60 ns inside an `AsyncLocalStorage` store).
import type { BoundaryTurns } from '@provino/types'
import { isThenable } from '../internal/thenable.ts'

/** Settled once, so a turn allocates only the promise `then` returns. */
const SETTLED: Promise<void> = Promise.resolve()

/**
 * How many turns past its total a count goes on while nothing waits for it: core's own code may get
 * to the next boundary (`owe`) after the count reached what was due so far, and the count must still
 * hold the turns that passed. It stops then, so a wait on a timer (an async lifecycle listener, a
 * retry's delay) never keeps it spinning.
 */
const SLACK = 32

/**
 * Counts the turns since the last function of a file ended. `through` calls a function and starts
 * a count with what its end costs, `owe` adds each boundary passed, and `wait` holds the next
 * function back until the count is reached. Nothing is counted before the file's first function
 * ends (`reset`).
 */
export class TurnClock {
  /** Bumped by every new count: a turn of a replaced count does nothing and queues nothing. */
  #generation = 0
  /** Bumped by every call: a promise that settles after the next call started (a timeout) starts no count. */
  #calls = 0
  /** The turns counted since the last function ended; `-1` while nothing is counted. */
  #counted = -1
  /** The turns the next function waits for, counted from the same point. */
  #due = 0
  /** Whether a turn is queued. */
  #ticking = false
  /**
   * Resolves the waits of the next function, on the turn the count is reached. A wait is never
   * dropped: a new count or a reset lets it go at once, so no call can be left waiting.
   */
  #release: (() => void) | undefined = undefined
  /** This count's turn, made once a count. */
  #turn: () => void = () => {}

  /** Stops counting: the next function starts at once, until a function ends again. */
  reset(): void {
    this.#generation += 1
    this.#counted = -1
    this.#due = 0
    this.#ticking = false
    this.#letGo()
  }

  /**
   * Calls `call` (a file's function, through core's call of it) and starts a count with `turns`
   * due as it ends: when it returns or throws, or on the turn after the promise it returned settles.
   */
  through(call: () => unknown, turns: number): unknown {
    this.#calls += 1
    const mine = this.#calls
    let value: unknown
    try {
      value = call()
    } catch (error) {
      this.#ended(turns)
      throw error
    }
    if (!isThenable(value)) {
      this.#ended(turns)
      return value
    }
    const settled = (): void => {
      if (this.#calls === mine) this.#ended(turns)
    }
    value.then(settled, settled)
    return value
  }

  /** The run passed a boundary that costs `turns` on the way to the next function. */
  owe(turns: number): void {
    if (this.#counted < 0) return
    this.#due += turns
    // A count that stopped (`SLACK` turns past its total) goes on from where it stopped: the turns
    // it missed are lost, so the next function starts later than the sum, never earlier.
    this.#tick()
  }

  /**
   * Before the next function: a promise that resolves on the turn the count is reached, or
   * `undefined` when it has been (or nothing is counted), so the caller adds no turn of its own.
   * The next function starts on the turn after the clock's last, which is the count's own last turn.
   */
  wait(): Promise<void> | undefined {
    if (this.#counted < 0 || this.#counted >= this.#due) return undefined
    return new Promise((resolve) => {
      // Calls that wait side by side (the executor counts none, but nothing may hang) all go.
      const before = this.#release
      this.#release =
        before === undefined
          ? resolve
          : () => {
              before()
              resolve()
            }
    })
  }

  /** A function ended, which costs `turns` before the next one: counts from now. */
  #ended(turns: number): void {
    this.#generation += 1
    this.#counted = 0
    // The next function starts on the turn after the clock's last: that turn is the sum's last.
    this.#due = turns - 1
    this.#ticking = false
    this.#letGo()
    const generation = this.#generation
    this.#turn = () => {
      if (generation !== this.#generation) return
      this.#counted += 1
      const release = this.#release
      if (
        this.#counted < this.#due ||
        (release === undefined && this.#counted < this.#due + SLACK)
      ) {
        SETTLED.then(this.#turn)
        return
      }
      this.#ticking = false
      this.#letGo()
    }
    this.#tick()
  }

  /** Resolves every wait now. */
  #letGo(): void {
    const release = this.#release
    this.#release = undefined
    release?.()
  }

  #tick(): void {
    if (this.#ticking || this.#counted >= this.#due + SLACK) return
    this.#ticking = true
    SETTLED.then(this.#turn)
  }
}

/** Whether a policy's turns ask for any wait at all: with none, the executor makes no clock. */
export function anyTurns(turns: BoundaryTurns): boolean {
  return (
    turns.hookStart > 0 ||
    turns.hookEnd > 0 ||
    turns.fnStart > 0 ||
    turns.fnEnd > 0 ||
    turns.testStart > 0 ||
    turns.testEnd > 0
  )
}
