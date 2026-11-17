// Error attribution (T5.11, Track 5 decision 6): who an error is charged to when the process raises
// it (an uncaught exception, a rejection with no handler) or a `done` is called after its test
// ended. `errors.lateErrors` picks the rule:
//
// - `fail-owner` (jest-circus 30.5 `eventHandler.ts` `case 'error'`, `unhandledRejectionHandler`):
//   the error belongs to the test whose async context raised it (`currentTest.get()`), even when
//   that test has ended. An exception fails a running test at once; a rejection waits in a map
//   keyed by its promise until the test's body is over (a `rejectionHandled` in between drops it).
//   Whatever is left for an ended test, or for a hook's suite, is reported as `unhandled-error`
//   events charged to that task when the file ends. An error no test or hook raised (a timer the
//   file's module scope set) is the running file's, as circus files it under `state.unhandledErrors`
//   (its rejection under `state.unhandledRejectionErrorByPromise`, until `run_finish`), which is
//   the file's `testExecError` (`cli/uncaught-during-test`); between files it is the run's.
// - `report-run` (Vitest 5.0): every such error is an `unhandled-error` charged to the run, at once.
//
// `errors.processListeners` says where the listeners sit: beside the process's own for the worker's
// life (`alongside`), or, as jest-circus 30.5.2's `injectGlobalErrorHandlers` and
// `restoreGlobalErrorHandlers` place its own (`per-file`), as the process's only ones while a file
// runs, the process's own taken off and put back when the file ends. After the file an error Node
// reports is then the process's own listeners' (a library loaded outside the test files may have one:
// Next.js's transformer installs an unhandled-rejection filter), and the runtime keeps listening, to
// charge it, only for an event the process has no listener of its own for: there Jest's process would
// die on Node's report (`cli/uncaught-after-run`), and the runtime fails the test that left it (D7).
//
// Core never installs a listener by itself: `captureProcessErrors` does, for the worker.
import type { CorePolicy, Frame, RuntimeEvent, TaskId, UnhandledErrorOrigin } from '@provino/types'
import { serializeError } from '../errors.ts'
import type { AttemptState } from '../internal/model.ts'

/**
 * The part of `process` the listeners need, so an `EventEmitter` stands in for it in tests.
 */
export type ProcessLike = Pick<
  NodeJS.EventEmitter,
  'on' | 'removeListener' | 'removeAllListeners' | 'rawListeners'
>

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
  /** `undefined` for an error no test or hook raised: it is charged to the running file. */
  readonly frame: Frame | undefined
}

/** The runtime's attribution of errors the code did not handle. */
export class ProcessErrors {
  readonly #config: ProcessErrorsConfig
  readonly #pending = new Map<Promise<unknown>, Pending>()
  /** Tests of the current file that an event charged an error to after they ended. */
  readonly #chargedTests = new Set<TaskId>()
  #chargedFiles = 0
  /**
   * Errors no test owned (the run's, or a hook's outside any test), over the runtime's life: a
   * describe retry compares it, as circus's `processErrorGeneration`. One charged to an ended test
   * is that test's, not counted here. A rejection no test or hook made is counted as it is held,
   * not when `flush` charges it: circus raises the generation as such a rejection is reported
   * (`eventHandler.ts` `case 'error'`), so it stops the retry even if it is handled later.
   */
  #unowned = 0
  /** Whether a file is running: a rejection reported outside one is charged at once. */
  #active = false
  /** The file that is running, or ran last. */
  #fileId: TaskId | undefined
  /** The listeners `listenForProcessErrors` placed, told when a file starts and ends. */
  readonly #listenings = new Set<FileBoundListening>()

  constructor(config: ProcessErrorsConfig) {
    this.#config = config
  }

  /** Whether a file is running now. */
  get active(): boolean {
    return this.#active
  }

  /** Tells `listening` when each file starts and ends, until the returned function is called. */
  bind(listening: FileBoundListening): () => void {
    this.#listenings.add(listening)
    return () => {
      this.#listenings.delete(listening)
    }
  }

  /** Whether an error was charged to the current file's tests or to the file itself. */
  get failsFile(): boolean {
    return this.#chargedTests.size > 0 || this.#chargedFiles > 0
  }

  /** How many errors, so far, went to the run or to a hook outside any test. */
  get unowned(): number {
    return this.#unowned
  }

  /**
   * The errors charged to a test after it ended were dropped with the describe attempt they came
   * in (`setDescribeRetry`): they no longer fail the file.
   */
  forget(testId: TaskId): void {
    this.#chargedTests.delete(testId)
  }

  /** Starts a file: nothing is charged yet. */
  startFile(fileId: TaskId): void {
    this.#fileId = fileId
    this.#chargedTests.clear()
    this.#chargedFiles = 0
    this.#active = true
    for (const listening of this.#listenings) listening.fileStarts()
  }

  /**
   * Reports an error the code did not handle. `promise` is given for a rejection with no handler,
   * which `fail-owner` holds until the owner's body is over; every other error is charged now.
   */
  report(origin: UnhandledErrorOrigin, error: unknown, promise?: Promise<unknown>): void {
    const frame = this.#config.frame()
    // The run's own error: the policy says so, or no test or hook raised it and no file is running.
    if (this.#config.lateErrors === 'report-run' || (frame === undefined && !this.#active)) {
      this.#emit(null, frame, origin, error)
      return
    }
    // Between files nothing is left to wait for: a rejection Node reports after the file ended (the
    // worker yields a turn for it) is charged to its test at once.
    if (promise !== undefined && this.#active) {
      if (frame === undefined) this.#unowned++
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
        pending.frame !== undefined &&
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
    for (const { frame, error } of this.#pending.values()) {
      // One no test or hook made was counted as it was held (`unowned`).
      this.#charge(frame, 'unhandledRejection', error, frame === undefined)
    }
    this.#pending.clear()
    // circus's `teardown`: from here an error is the process's own listeners', where it has any.
    for (const listening of this.#listenings) listening.fileEnds()
  }

  /**
   * Charges an error to the test or hook the frame is in, or, with no frame (no test or hook
   * raised it), to the file that is running. `counted`: it is already in `unowned`.
   */
  #charge(
    frame: Frame | undefined,
    origin: UnhandledErrorOrigin,
    error: unknown,
    counted = false,
  ): void {
    if (frame !== undefined && frame.test !== null) {
      const attempt = this.#config.runningAttempt(frame)
      if (attempt !== undefined) {
        attempt.errors.push(error)
        return
      }
      // Only a test of the file now running fails it: a timer of an earlier file's test may fire
      // during this one, and its error is reported with its owner without failing this file.
      if (frame.fileId === this.#fileId) this.#chargedTests.add(frame.test.id)
      this.#emit(frame.test.id, frame, origin, error)
      return
    }
    // A hook outside any test (beforeAll, afterAll), or no test or hook at all: the file fails.
    if (frame === undefined || frame.fileId === this.#fileId) this.#chargedFiles++
    this.#emit(frame?.fileId ?? this.#fileId ?? null, frame, origin, error, counted)
  }

  #emit(
    ownerId: TaskId | null,
    frame: Frame | undefined,
    origin: UnhandledErrorOrigin,
    error: unknown,
    counted = false,
  ): void {
    if (!counted && (ownerId === null || frame?.test == null)) this.#unowned++
    this.#config.emit({
      type: 'unhandled-error',
      ownerId,
      lastTestId: frame?.test?.id ?? this.#config.lastTestId(),
      origin,
      // Not shaped, even when a test owns it: this is an error charged after the test's `test_done`,
      // which jest-circus's `formatNodeAssertErrors` has already run for (`cli/node-assert-unhandled`).
      error: serializeError(error),
      t: this.#config.now(),
    })
  }
}

/** What `ProcessErrors` tells a placement of listeners as files start and end. */
interface FileBoundListening {
  fileStarts(): void
  fileEnds(): void
}

/** The events the runtime listens for, in the order jest-circus 30.5.2 takes them over. */
const EVENTS = ['uncaughtException', 'unhandledRejection', 'rejectionHandled'] as const
type ProcessEvent = (typeof EVENTS)[number]
type Listener = (...args: unknown[]) => void

/**
 * The runtime's three listeners on one target, placed as `errors.processListeners` says.
 * `per-file` makes jest-circus 30.5.2's calls (`globalErrorHandlers.ts`), so a target whose methods
 * a library replaced (Next.js's filter replaces `on`, `removeAllListeners` and `listeners` for
 * `unhandledRejection`) ends in the state it ends in under Jest.
 */
class Listening implements FileBoundListening {
  readonly #target: ProcessLike
  readonly #ours: Readonly<Record<ProcessEvent, Listener>>
  readonly #perFile: boolean
  /** The process's own listeners, taken off while a file runs; `undefined` between files. */
  #taken: ReadonlyMap<ProcessEvent, readonly Listener[]> | undefined

  constructor(
    target: ProcessLike,
    ours: Readonly<Record<ProcessEvent, Listener>>,
    perFile: boolean,
  ) {
    this.#target = target
    this.#ours = ours
    this.#perFile = perFile
    for (const event of EVENTS) target.on(event, ours[event])
    // Between files the process's own listeners have an error first (none is running yet).
    if (perFile) this.#yieldToOwn()
  }

  /** circus's `injectGlobalErrorHandlers`: the process's own off, ours the only ones. */
  fileStarts(): void {
    if (!this.#perFile || this.#taken !== undefined) return
    const taken = new Map<ProcessEvent, readonly Listener[]>()
    for (const event of EVENTS) taken.set(event, this.#ownListeners(event))
    for (const event of EVENTS) this.#target.removeAllListeners(event)
    for (const event of EVENTS) this.#target.on(event, this.#ours[event])
    this.#taken = taken
  }

  /** circus's `restoreGlobalErrorHandlers`, except that ours stay for an event with none of its own. */
  fileEnds(): void {
    const taken = this.#taken
    if (taken === undefined) return
    this.#taken = undefined
    for (const event of EVENTS) {
      const own = taken.get(event) ?? []
      if (own.length === 0 && this.#ownListeners(event).length === 0) continue
      this.#target.removeListener(event, this.#ours[event])
      for (const listener of own) this.#target.on(event, listener)
    }
  }

  /** Removes ours, and puts back what a file still running took off. */
  stop(): void {
    const taken = this.#taken
    this.#taken = undefined
    for (const event of EVENTS) {
      this.#target.removeListener(event, this.#ours[event])
      for (const listener of taken?.get(event) ?? []) this.#target.on(event, listener)
    }
  }

  /** Takes ours off each event the process has a listener of its own for. */
  #yieldToOwn(): void {
    for (const event of EVENTS) {
      if (this.#ownListeners(event).length > 0) {
        this.#target.removeListener(event, this.#ours[event])
      }
    }
  }

  /** The target's listeners for `event` other than ours (`rawListeners`, as circus reads them). */
  #ownListeners(event: ProcessEvent): Listener[] {
    const ours = this.#ours[event]
    return (this.#target.rawListeners(event) as Listener[]).filter((listener) => listener !== ours)
  }
}

/**
 * Listens for the process's uncaught exceptions and rejections with no handler, and reports them,
 * placed as `processListeners` says (`CorePolicy.errors.processListeners`). Returns the function
 * that removes the listeners. The worker calls it once; core never does.
 */
export function listenForProcessErrors(
  errors: ProcessErrors,
  target: ProcessLike,
  processListeners: CorePolicy['errors']['processListeners'] = 'alongside',
): () => void {
  const uncaught = (error: unknown, origin: unknown): void => {
    errors.report(
      origin === 'unhandledRejection' ? 'unhandledRejection' : 'uncaughtException',
      error,
    )
  }
  const rejected = (reason: unknown, promise: unknown): void => {
    errors.report('unhandledRejection', reason, promise as Promise<unknown>)
  }
  const handled = (promise: unknown): void => {
    errors.handled(promise as Promise<unknown>)
  }
  const listening = new Listening(
    target,
    { uncaughtException: uncaught, unhandledRejection: rejected, rejectionHandled: handled },
    processListeners === 'per-file',
  )
  // Asked for while a file runs (a test's own call): that file is circus's from now on.
  if (errors.active) listening.fileStarts()
  const unbind = errors.bind(listening)
  return () => {
    unbind()
    listening.stop()
  }
}
