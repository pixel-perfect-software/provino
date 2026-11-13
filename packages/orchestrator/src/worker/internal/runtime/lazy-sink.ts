// The failure report's lazy values (T6.10). A failed attempt's lazy log lives in the attempt's own
// run, which is gone by the time the test ends, so the worker hands the log here when the attempt
// fails (`record`) and this sink puts it on the test's `test-end`, when the test failed. A test
// that passes records nothing and its `test-end` passes through untouched.
import type { EventSink, LazyEvaluation, RuntimeEvent, TaskId } from '@provino/types'

/**
 * The sink and the way to give it a failed attempt's lazy values.
 * @internal
 */
export interface LazyReport {
  readonly sink: EventSink
  /** The lazy values the latest failed attempt of `testId` evaluated (none: empty); the latest call wins. */
  record(testId: TaskId, lazies: readonly LazyEvaluation[]): void
}

/**
 * Wraps `next`: every event passes through untouched, except the `test-end` of a test with
 * recorded values that ended `fail`, whose result gets `lazies`. Whatever was recorded for a test
 * is forgotten when it ends.
 * @internal
 */
export function lazyReportSink(next: EventSink): LazyReport {
  const held = new Map<TaskId, readonly LazyEvaluation[]>()
  return {
    record(testId, lazies) {
      // An empty list is the latest attempt saying it evaluated none: it replaces an earlier
      // attempt's list rather than leaving it to be attached to this one.
      if (lazies.length === 0) held.delete(testId)
      else held.set(testId, lazies)
    },
    sink: {
      emit(event: RuntimeEvent): void {
        if (event.type === 'test-end' && held.size > 0) {
          const lazies = held.get(event.id)
          held.delete(event.id)
          if (lazies !== undefined && event.result.state === 'fail') {
            next.emit({ ...event, result: { ...event.result, lazies } })
            return
          }
        }
        next.emit(event)
      },
    },
  }
}
