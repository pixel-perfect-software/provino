// Track 5 §Types → Test context, current test, `.each`/`.for`.
import type { RuntimeHookKind } from './events.ts'
import type { TaskId, TestTask } from './tree.ts'

/**
 * The context a test receives. Dialects extend it (Vitest adds `expect`), and fixtures are merged
 * in by type.
 * @public
 */
export interface TestContext {
  readonly task: Readonly<TestTask>
  /** Aborted on timeout, bail or interrupt. */
  readonly signal: AbortSignal
  skip(note?: string): never
  skip(condition: boolean, note?: string): void
  annotate(message: string, kind?: string): Promise<void>
  onTestFinished(fn: (ctx: TestContext) => void | Promise<void>, timeoutMs?: number): void
  onTestFailed(fn: (ctx: TestContext) => void | Promise<void>, timeoutMs?: number): void
}

/**
 * What is running in the current async context: a test (with its hooks), or a suite hook.
 * @public
 */
export interface Frame {
  readonly test: TestTask | null
  readonly hook: { readonly kind: RuntimeHookKind; readonly ownerId: TaskId } | null
  readonly fileId: TaskId
  /** The retry attempt, from 0. */
  readonly attempt: number
  /** The repeat (`repeats`), from 0; each repeat's attempts start at 0 again. 0 for suite hooks. */
  readonly repeat: number
}

/**
 * The retry a file sets for every test that declares none of its own (Jest's `jest.retryTimes`):
 * the runtime reads it when a suite starts running, so it covers tests registered before the call
 * and after it.
 * @public
 */
export interface DefaultRetry {
  /** Retries after the first attempt; 0 (or a number below 1) is none. */
  readonly count: number
  /** Milliseconds to wait before each retry. */
  readonly delay: number
  /** Retry a failed test at once, even where the policy's `retry.timing` is `deferred`. */
  readonly immediate: boolean
  /** Keep the errors of the attempts that were retried on the result (`logErrorsBeforeRetry`). */
  readonly logErrors: boolean
}

/**
 * The current-test lookup, backed by AsyncLocalStorage. Mocks and timers (attribution), lazy
 * values and expect state read it.
 * @public
 */
export interface CurrentTest {
  run<R>(frame: Frame, fn: () => R): R
  get(): Frame | undefined
  bind<F extends (...args: never[]) => unknown>(fn: F): F
}

/**
 * Loads a test file for the runtime to collect. The worker passes the loader's import here
 * (Track 1 §Module boundaries, rule 6), so the core never imports the loader.
 * @public
 */
export type ImportFile = (path: string) => Promise<unknown>

/**
 * The arguments a `.each` row passes: when every row is a tuple they spread, otherwise each row is
 * one argument (both runners decide for the whole table, not per row). The brackets stop the
 * check distributing over a mixed table's union of row types.
 * @public
 */
export type EachRowArgs<Row> = [Row] extends [readonly unknown[]] ? [...Row] : [Row]

/**
 * `.each` (rows spread into arguments) and `.for` (the row and the context).
 * @public
 */
export interface EachApi<Ctx> {
  each<const Row>(
    rows: readonly Row[],
  ): (name: string, fn: (...args: EachRowArgs<Row>) => unknown, timeoutMs?: number) => void
  for<const Row>(rows: readonly Row[]): (name: string, fn: (row: Row, ctx: Ctx) => unknown) => void
}
