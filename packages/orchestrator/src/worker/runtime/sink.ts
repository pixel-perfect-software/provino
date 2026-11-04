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

/** The part of the expect state source the sink reads. */
export interface RunStates {
  stateOf(testId: string, run: Run): MatcherState | undefined
}

/**
 * Wraps `next`: every event passes through untouched, except `test-end`, whose result gets
 * `assertions` (calls made) and `passingAssertions` from the state of the test's last attempt
 * (the one that decided the result; Jest counts `numPassingAsserts` for it). A test with no
 * attempt (skipped or todo) or an attempt that never asserted has 0 of each. The sink forgets a
 * test once it ends.
 */
export function assertionCountSink(states: RunStates, next: EventSink): EventSink {
  const lastRun = new Map<TaskId, Run>()
  return {
    emit(event: RuntimeEvent): void {
      if (event.type === 'test-attempt-end') {
        lastRun.set(event.id, { attempt: event.attempt, repeat: event.repeat })
      } else if (event.type === 'test-end') {
        const run = lastRun.get(event.id)
        lastRun.delete(event.id)
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
