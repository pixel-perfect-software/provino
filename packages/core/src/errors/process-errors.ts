// Error attribution (T5.11, Track 5 decision 6): who an error is charged to when the process raises
// it (an uncaught exception, a rejection with no handler) or a `done` is called after its test
// ended. `errors.lateErrors` picks the rule:
//
// - `fail-owner` (jest-circus 30.5 `eventHandler.ts` `case 'error'`, `unhandledRejectionHandler`):
//   the error belongs to the test whose async context raised it (`currentTest.get()`), even when
//   that test has ended. An exception fails a running test at once; a rejection waits in a map
//   keyed by its promise until the test's body is over (a `rejectionHandled` in between drops it).
//   Whatever is left for an ended test, or for a hook's suite, is reported as `unhandled-error`
//   events charged to that task when the file ends. An error with no owner is charged to the run.
// - `report-run` (Vitest 5.0): every such error is an `unhandled-error` charged to the run, at once.
//
// Core never installs a listener by itself: `captureProcessErrors` does, for the worker.
import type { Frame, RuntimeEvent, TaskId, UnhandledErrorOrigin } from '@provino/types'
import { serializeError } from '../errors.ts'
import type { AttemptState } from '../internal/model.ts'

/**
 * The part of `process` the listeners need: `on` and `removeListener`, so an `EventEmitter` stands
 * in for it in tests.
 */
export type ProcessLike = Pick<NodeJS.EventEmitter, 'on' | 'removeListener'>

/** What `ProcessErrors` needs from the runtime and the executor. */
export interface ProcessErrorsConfig {
  /** `CorePolicy.errors.lateErrors`. */
  readonly lateErrors: 'fail-owner' | 'report-run'
  readonly emit: (event: RuntimeEvent) => void
  readonly now: () => number
  /** The frame of the async context the error was raised in. */
  readonly frame: () => Frame | undefined
  /** The attempt of a test, while it runs (not once it is done). */
  readonly runningAttempt: (frame: Frame) => AttemptState | undefined
  /** The test that started last, for `lastTestId`. */
  readonly lastTestId: () => TaskId | null
}

/** A rejection nobody has handled yet, and who it is charged to. */
interface Pending {
  readonly error: unknown
  readonly frame: Frame
}

/** The runtime's attribution of errors the code did not handle. */
export class ProcessErrors {
  readonly #config: ProcessErrorsConfig
  readonly #pending = new Map<Promise<unknown>, Pending>()
  /** Tests of the current file that an event charged an error to after they ended. */
  readonly #chargedTests = new Set<TaskId>()
  #chargedFiles = 0
  /** Whether a file is running: a rejection reported outside one is charged at once. */
  #active = false

  constructor(config: ProcessErrorsConfig) {
    this.#config = config
  }

  /** Whether an error was charged to the current file's tests or to the file itself. */
  get failsFile(): boolean {
    return this.#chargedTests.size > 0 || this.#chargedFiles > 0
  }

  /** Starts a file: nothing is charged yet. */
  startFile(): void {
    this.#chargedTests.clear()
    this.#chargedFiles = 0
    this.#active = true
  }

  /**
   * Reports an error the code did not handle. `promise` is given for a rejection with no handler,
   * which `fail-owner` holds until the owner's body is over; every other error is charged now.
   */
  report(origin: UnhandledErrorOrigin, error: unknown, promise?: Promise<unknown>): void {
    const frame = this.#config.frame()
    if (this.#config.lateErrors === 'report-run') {
      this.#emit(null, frame, origin, error)
      return
    }
    if (frame === undefined) {
      this.#emit(null, frame, origin, error)
      return
    }
    // Between files nothing is left to wait for: a rejection Node reports after the file ended (the
    // worker yields a turn for it) is charged to its test at once.
    if (promise !== undefined && this.#active) {
      this.#pending.set(promise, { error, frame })
      return
    }
    this.#charge(frame, origin, error)
  }

  /** A rejection got its handler after all: it is no longer an error. */
  handled(promise: Promise<unknown>): void {
    this.#pending.delete(promise)
  }

  /**
   * The rejections held for a running attempt, taken out: the owner's body (or hook) is over, so
   * they are its errors now.
   */
  take(frame: Frame): unknown[] {
    const taken: unknown[] = []
    for (const [promise, pending] of this.#pending) {
      if (
        pending.frame.test !== null &&
        frame.test !== null &&
        pending.frame.test.id === frame.test.id &&
        pending.frame.attempt === frame.attempt &&
        pending.frame.repeat === frame.repeat
      ) {
        taken.push(pending.error)
        this.#pending.delete(promise)
      }
    }
    return taken
  }

  /** The file is over: every rejection still held is charged now, to the task that owned it. */
  flush(): void {
    this.#active = false
    for (const pending of this.#pending.values()) {
      this.#charge(pending.frame, 'unhandledRejection', pending.error)
    }
    this.#pending.clear()
  }

  /** Charges an error to the test or hook the frame is in. */
  #charge(frame: Frame, origin: UnhandledErrorOrigin, error: unknown): void {
    if (frame.test !== null) {
      const attempt = this.#config.runningAttempt(frame)
      if (attempt !== undefined) {
        attempt.errors.push(error)
        return
      }
      this.#chargedTests.add(frame.test.id)
      this.#emit(frame.test.id, frame, origin, error)
      return
    }
    // A hook outside any test (beforeAll, afterAll): the file fails.
    this.#chargedFiles++
    this.#emit(frame.fileId, frame, origin, error)
  }

  #emit(
    ownerId: TaskId | null,
    frame: Frame | undefined,
    origin: UnhandledErrorOrigin,
    error: unknown,
  ): void {
    this.#config.emit({
      type: 'unhandled-error',
      ownerId,
      lastTestId: frame?.test?.id ?? this.#config.lastTestId(),
      origin,
      error: serializeError(error),
      t: this.#config.now(),
    })
  }
}

/**
 * Listens for the process's uncaught exceptions and rejections with no handler, and reports them.
 * Returns the function that removes the listeners. The worker calls it once; core never does.
 */
export function listenForProcessErrors(errors: ProcessErrors, target: ProcessLike): () => void {
  const uncaught = (error: Error, origin: string): void => {
    errors.report(
      origin === 'unhandledRejection' ? 'unhandledRejection' : 'uncaughtException',
      error,
    )
  }
  const rejected = (reason: unknown, promise: Promise<unknown>): void => {
    errors.report('unhandledRejection', reason, promise)
  }
  const handled = (promise: Promise<unknown>): void => {
    errors.handled(promise)
  }
  target.on('uncaughtException', uncaught)
  target.on('unhandledRejection', rejected)
  target.on('rejectionHandled', handled)
  return () => {
    target.removeListener('uncaughtException', uncaught)
    target.removeListener('unhandledRejection', rejected)
    target.removeListener('rejectionHandled', handled)
  }
}
