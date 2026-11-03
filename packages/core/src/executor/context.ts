// The test context (Track 5 §Types → TestContext). B07 gives it `task`, `signal`,
// `onTestFinished` and `onTestFailed`; `skip` and `annotate` arrive with T5.8.
import type { TestContext, TestTask } from '@provino/types'
import { CoreError } from '../errors.ts'
import type { AttemptState, UserFn } from '../internal/model.ts'

/** A context for one test attempt. `attempt` is filled in before the test runs. */
export function createTestContext(task: TestTask, attempt: () => AttemptState): TestContext {
  const context: TestContext = {
    task,
    get signal(): AbortSignal {
      return attempt().controller.signal
    },
    skip(): never {
      throw new CoreError('CORE_NOT_IMPLEMENTED', '`ctx.skip` arrives with T5.8')
    },
    annotate(): Promise<void> {
      return Promise.reject(
        new CoreError('CORE_NOT_IMPLEMENTED', '`ctx.annotate` arrives with T5.8'),
      )
    },
    onTestFinished(fn: (ctx: TestContext) => void | Promise<void>, timeoutMs?: number): void {
      addCallback(attempt(), 'onTestFinished', fn, timeoutMs)
    },
    onTestFailed(fn: (ctx: TestContext) => void | Promise<void>, timeoutMs?: number): void {
      addCallback(attempt(), 'onTestFailed', fn, timeoutMs)
    },
  }
  return context
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
