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
  readonly attempt: number
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
 * The arguments a `.each` row spreads into: a tuple row spreads, any other row is one argument.
 * @public
 */
export type EachRowArgs<Row> = Row extends readonly unknown[] ? [...Row] : [Row]

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
