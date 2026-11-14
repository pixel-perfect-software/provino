// The assertion-count sink (B09's `passingAssertions` handoff). Core reports `assertions` and
// `passingAssertions` as 0, because the counts live in `@provino/expect`'s per-attempt state, which
// core never imports. This sink sits between core and the packer: it remembers the last attempt of
// each test, and when the test ends it fills the counts from that attempt's state.
import type { EventSink, MatcherState, RuntimeEvent, TaskId } from '@provino/types'

/** Which run of a test: the same two numbers `test-attempt-end` carries. */
interface Run {
  readonly attempt: number
  readonly repeat: number
}

/**
 * The part of the expect state source the sink reads.
 * @internal
 */
export interface RunStates {
  stateOf(testId: string, run: Run): MatcherState | undefined
}

/** What the sink remembers of a test between its attempts. */
interface Runs {
  /** The latest run, whatever its state. */
  latest: Run
  /** The latest run that ended in a failure nothing retries, if any did. */
  failed?: Run
}

/**
 * Wraps `next`: every event passes through untouched, except a `test-attempt-end` that is
 * retried, which gets its own attempt's two counts (Jest reports that attempt's `test_done` too),
 * and `test-end`, whose result gets
 * `assertions` (calls made) and `passingAssertions` from the state of the run that decided the
 * result (Jest counts `numPassingAsserts` for it). That is the latest run that failed for good
 * (state `fail`, no retry following), because a test fails if any repeat does and a later
 * repeat that passed must not stand in for it; with no such run, the latest run. A test with no
 * attempt (skipped or todo) or a run that never asserted has 0 of each. The sink forgets a test
 * once it ends.
 * @internal
 */
export function assertionCountSink(states: RunStates, next: EventSink): EventSink {
  const runs = new Map<TaskId, Runs>()
  return {
    emit(event: RuntimeEvent): void {
      if (event.type === 'test-attempt-end') {
        const run: Run = { attempt: event.attempt, repeat: event.repeat }
        const seen = runs.get(event.id) ?? { latest: run }
        seen.latest = run
        if (event.state === 'fail' && !event.willRetry) seen.failed = run
        runs.set(event.id, seen)
        if (event.willRetry) {
          // A retried attempt is reported on its own too (Jest's `test_done` for it).
          const state = states.stateOf(event.id, run)
          next.emit({
            ...event,
            assertions: state?.assertionCalls ?? 0,
            passingAssertions: state?.numPassingAsserts ?? 0,
          })
          return
        }
      } else if (event.type === 'test-end') {
        const seen = runs.get(event.id)
        runs.delete(event.id)
        const run = seen?.failed ?? seen?.latest
        const state = run === undefined ? undefined : states.stateOf(event.id, run)
        next.emit({
          ...event,
          result: {
            ...event.result,
            assertions: state?.assertionCalls ?? 0,
            passingAssertions: state?.numPassingAsserts ?? 0,
          },
        })
        return
      }
      next.emit(event)
    },
  }
}
