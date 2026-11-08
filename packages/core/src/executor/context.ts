// The test context (T5.8, Track 5 §Types → TestContext): `task`, `signal`, `skip`, `annotate`,
// `onTestFinished` and `onTestFailed`. Under `firstArg: 'context'` it is also a function: calling
// it (a stray `done()`) throws the policy's `doneDeprecatedMessage`, as Vitest 5.0's context does.
// A dialect adds what is its own (Vitest's `expect`) on the object this returns.
import type { RuntimeEvent, SourceLocation, TestContext, TestTask } from '@provino/types'
import { CoreError } from '../errors.ts'
import type { AttemptState, UserFn } from '../internal/model.ts'

/**
 * The error `ctx.skip()` throws to end a test as skipped. The executor catches it wherever user
 * code was running (the body, an each-hook) and gives the test the `skip` state, with `note`.
 */
export class SkipSignal extends Error {
  readonly note: string | undefined

  constructor(note: string | undefined) {
    super(note === undefined ? 'test is skipped' : `test is skipped: ${note}`)
    this.note = note
  }
}

/** What a context needs from the runtime. */
export interface ContextEnv {
  /** `CorePolicy.doneDeprecatedMessage`: the text a call to the context throws, if it is callable. */
  readonly doneDeprecatedMessage: string | null
  /** Emits an `annotation` event. */
  readonly emit: (event: RuntimeEvent) => void
  readonly now: () => number
  /** Where the annotate call was made, or `null` when locations are off. */
  readonly callerLocation: (entry: (...args: never[]) => unknown) => SourceLocation | null
}

/**
 * A context for one test attempt. `attempt` returns the attempt the context belongs to; it is
 * called only once the test runs, so the attempt can hold the context it is built with.
 */
export function createTestContext(
  task: TestTask,
  attempt: () => AttemptState,
  env: ContextEnv,
): TestContext {
  const { doneDeprecatedMessage } = env
  const base: object =
    doneDeprecatedMessage === null
      ? {}
      : () => {
          throw new Error(doneDeprecatedMessage)
        }
  const skip = (conditionOrNote?: boolean | string, note?: string): void => {
    if (conditionOrNote === false) return
    throw new SkipSignal(typeof conditionOrNote === 'string' ? conditionOrNote : note)
  }
  const annotate = (message: string, kind: string = 'notice'): Promise<void> => {
    const state = attempt()
    env.emit({
      type: 'annotation',
      testId: task.id,
      message,
      kind,
      location: env.callerLocation(annotate),
      t: env.now(),
    })
    void state
    return Promise.resolve()
  }
  Object.defineProperties(base, {
    task: { value: task, enumerable: true },
    signal: {
      get(): AbortSignal {
        return attempt().controller.signal
      },
      enumerable: true,
    },
    skip: { value: skip, enumerable: true },
    annotate: { value: annotate, enumerable: true },
    onTestFinished: {
      value(fn: (ctx: TestContext) => void | Promise<void>, timeoutMs?: number): void {
        addCallback(attempt(), 'onTestFinished', fn, timeoutMs)
      },
      enumerable: true,
    },
    onTestFailed: {
      value(fn: (ctx: TestContext) => void | Promise<void>, timeoutMs?: number): void {
        addCallback(attempt(), 'onTestFailed', fn, timeoutMs)
      },
      enumerable: true,
    },
  })
  return base as TestContext
}

/** Adds an `onTestFinished`/`onTestFailed` callback to an attempt. */
export function addCallback(
  attempt: AttemptState | undefined,
  kind: 'onTestFinished' | 'onTestFailed',
  fn: unknown,
  timeoutMs: number | undefined,
): void {
  if (typeof fn !== 'function') {
    throw new CoreError('CORE_INVALID_ARGUMENT', `"${kind}" expects a function, got ${typeof fn}`)
  }
  if (attempt === undefined) {
    throw new CoreError('CORE_TEST_CALLBACK_CONTEXT', `${kind}() can only be called inside a test`)
  }
  if (attempt.inCallbacks) {
    throw new CoreError(
      'CORE_TEST_CALLBACK_CONTEXT',
      `Cannot call "${kind}" inside an onTestFinished or onTestFailed callback`,
    )
  }
  const list = kind === 'onTestFinished' ? attempt.onFinished : attempt.onFailed
  list.push({ fn: fn as UserFn, timeoutMs })
}
