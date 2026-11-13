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

/** The context's own keys, as assignment gives them to the object or the callable. */
interface ContextFields {
  task: TestTask
  signal: AbortSignal
  skip: (conditionOrNote?: boolean | string, note?: string) => void
  annotate: TestContext['annotate']
  onTestFinished: TestContext['onTestFinished']
  onTestFailed: TestContext['onTestFailed']
}

/**
 * A context for one test attempt, whose abort signal is `signal`. `attempt` returns the attempt the
 * context belongs to; it is called only once the test runs, so the attempt can hold the context it
 * is built with. Its keys are plain own data properties assigned in order, as Vitest 5.0's
 * `createTestContext` assigns them: writable and configurable (a write to `ctx.task` no longer
 * throws in strict code; the Jest dialect hands no function a context, so nothing there can see
 * it), and cheap to build, which matters once per attempt (T5.14: `Object.defineProperties` cost
 * about 1 µs here).
 */
export function createTestContext(
  task: TestTask,
  attempt: () => AttemptState,
  signal: AbortSignal,
  env: ContextEnv,
): TestContext {
  const { doneDeprecatedMessage } = env
  const context = (
    doneDeprecatedMessage === null
      ? {}
      : () => {
          throw new Error(doneDeprecatedMessage)
        }
  ) as ContextFields
  const annotate = (message: string, kind: string = 'notice'): Promise<void> => {
    env.emit({
      type: 'annotation',
      testId: task.id,
      message,
      kind,
      location: env.callerLocation(annotate),
      t: env.now(),
    })
    return Promise.resolve()
  }
  context.task = task
  context.signal = signal
  context.skip = (conditionOrNote?: boolean | string, note?: string): void => {
    if (conditionOrNote === false) return
    throw new SkipSignal(typeof conditionOrNote === 'string' ? conditionOrNote : note)
  }
  context.annotate = annotate
  context.onTestFinished = (fn, timeoutMs) => {
    addCallback(attempt(), 'onTestFinished', fn, timeoutMs)
  }
  context.onTestFailed = (fn, timeoutMs) => {
    addCallback(attempt(), 'onTestFailed', fn, timeoutMs)
  }
  return context as TestContext
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
