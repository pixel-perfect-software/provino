import type {
  Reporter,
  ReporterBus,
  ReporterEvents,
  ReporterHandlers,
  SerializedError,
} from '@provino/types'
import { serializeError } from './internal/serialize-error.ts'

/**
 * A reporter bus that also reports what went wrong inside it.
 * @public
 */
export interface ReporterBusHandle extends ReporterBus {
  /**
   * What the run should fail for: every error a reporter's handler threw, in the order they
   * happened, then each reporter's `lastError()` as of this call. Empty when the reporters are
   * all well.
   */
  failures(): readonly SerializedError[]
}

/** Calls one reporter's handler for an event; a reporter with no handler for it is skipped. */
async function call<K extends keyof ReporterEvents>(
  reporter: Reporter,
  event: K,
  args: ReporterEvents[K],
): Promise<void> {
  // Indexed through the mapped type, so `K` picks one handler, not the union of all of them.
  const handlers: ReporterHandlers = reporter
  const handler = handlers[event]
  if (handler === undefined) return
  await handler.apply(reporter, args)
}

/**
 * Creates the bus the coordinator sends every event through.
 *
 * - **Order.** An event goes to the reporters in the order they were added, each handler awaited
 *   before the next starts, so output order is deterministic and a slow reporter slows whoever
 *   emits (the workers, through the pack window). Events themselves are delivered one at a time,
 *   in the order `emit` was called: a second `emit` waits for the first to finish, so no reporter
 *   ever has two handlers running at once.
 * - **A reporter that throws** (or rejects) does not stop the others and does not fail `emit`.
 *   The error is recorded in `failures()` and sent to every *other* reporter as
 *   `error(error, 'reporter')` straight away, before the reporters after it get the event. It
 *   never goes back to the reporter that threw it, and a reporter that throws while handling
 *   such an error is recorded but not announced again.
 * - A reporter added during an `emit` first sees the next event.
 * @public
 */
export function createReporterBus(reporters: readonly Reporter[] = []): ReporterBusHandle {
  const registered: Reporter[] = [...reporters]
  const recorded: SerializedError[] = []
  let queue: Promise<void> = Promise.resolve()

  /** Calls each target in order; a reporter that throws is recorded and, if asked, announced at once. */
  async function dispatch<K extends keyof ReporterEvents>(
    event: K,
    args: ReporterEvents[K],
  ): Promise<void> {
    const targets = [...registered]
    // A reporter-error that itself failed to be handled is recorded and ends there.
    const announce = !(event === 'error' && args[1] === 'reporter')
    for (const reporter of targets) {
      try {
        await call(reporter, event, args)
      } catch (thrown) {
        const error = serializeError(thrown)
        recorded.push(error)
        if (!announce) continue
        // Before the remaining reporters get the event, so one registered after this one (a
        // writer at `run:end`) knows of the failure in time.
        for (const other of targets) {
          if (other === reporter) continue
          try {
            await call(other, 'error', [error, 'reporter'])
          } catch (again) {
            recorded.push(serializeError(again))
          }
        }
      }
    }
  }

  return {
    emit<K extends keyof ReporterEvents>(event: K, ...args: ReporterEvents[K]): Promise<void> {
      const done = queue.then(() => dispatch(event, args))
      // `dispatch` records what reporters throw and never rejects; this keeps the chain alive
      // even if a bug in it does.
      queue = done.catch(() => undefined)
      return done
    },
    add(reporter: Reporter): void {
      registered.push(reporter)
    },
    failures(): readonly SerializedError[] {
      const last: SerializedError[] = []
      for (const reporter of registered) {
        try {
          const error = reporter.lastError?.()
          if (error !== undefined) last.push(error)
        } catch (thrown) {
          last.push(serializeError(thrown))
        }
      }
      return [...recorded, ...last]
    },
  }
}
