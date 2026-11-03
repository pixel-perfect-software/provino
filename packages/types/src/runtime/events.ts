// Track 5 §Types → Event union: the one event model (build-plan §6 "Interfaces"). The worker's
// batched transport (`WorkerEvent`), the reporter bus and Track 12's `HarnessEvent` all carry
// these events; none defines its own. Fields Track 12 needs are part of the events and the tree:
// hook `ordinal`, `TestTask.dupIndex`, `TaskResult.passingAssertions` and `skipReason`, and
// `console.taskId`. See the package README.
import type { HookKind } from '../policy/core.ts'
import type { SerializedError, SourceLocation, TaskId, TaskNode, TaskResult } from './tree.ts'

/**
 * Every kind of hook the runtime reports: the four ordered by `core.hookOrder` (`HookKind`), plus
 * the wrapping hooks, the per-test callbacks and teardowns.
 * @public
 */
export type RuntimeHookKind =
  | HookKind
  | 'aroundAll'
  | 'aroundEach'
  | 'onTestFinished'
  | 'onTestFailed'
  | 'teardown'

/**
 * Where an unhandled error came from: a stray exception or rejection, a `done` called after the
 * test ended, or a test or hook registered after collection.
 * @public
 */
export type UnhandledErrorOrigin =
  | 'uncaughtException'
  | 'unhandledRejection'
  | 'late-done'
  | 'late-registration'

/**
 * One runtime event. Every event carries `t` (monotonic ms) and refers to tasks by id only, so
 * the union is clone-safe. Consumers must handle `test-attempt-*` (retries and repeats) and
 * `unhandled-error` explicitly; switch over `type` with an exhaustive default.
 * @public
 */
export type RuntimeEvent =
  | {
      readonly type: 'file-collect-start'
      readonly fileId: TaskId
      readonly path: string
      readonly t: number
    }
  | {
      readonly type: 'file-collect-end'
      readonly fileId: TaskId
      /** The file's whole tree, file node first, parents before children. */
      readonly tasks: readonly TaskNode[]
      readonly errors: readonly SerializedError[]
      readonly t: number
    }
  | { readonly type: 'suite-start'; readonly id: TaskId; readonly t: number }
  | {
      readonly type: 'suite-end'
      readonly id: TaskId
      readonly result: TaskResult
      readonly t: number
    }
  | { readonly type: 'test-start'; readonly id: TaskId; readonly t: number }
  | {
      readonly type: 'test-attempt-start'
      readonly id: TaskId
      readonly attempt: number
      readonly repeat: number
      readonly t: number
    }
  | {
      readonly type: 'test-attempt-end'
      readonly id: TaskId
      readonly attempt: number
      readonly repeat: number
      readonly state: 'pass' | 'fail' | 'skip'
      readonly errors: readonly SerializedError[]
      readonly willRetry: boolean
      readonly t: number
    }
  | {
      readonly type: 'test-end'
      readonly id: TaskId
      readonly result: TaskResult
      readonly t: number
    }
  | {
      readonly type: 'hook-start'
      /** The file or suite the hook is declared on. */
      readonly ownerId: TaskId
      /** The test an each-hook or per-test callback runs for; `null` for suite hooks. */
      readonly testId: TaskId | null
      readonly kind: RuntimeHookKind
      /** 0-based declaration index among the owner's hooks of this kind. */
      readonly ordinal: number
      readonly location: SourceLocation | null
      readonly t: number
    }
  | {
      readonly type: 'hook-end'
      readonly ownerId: TaskId
      readonly testId: TaskId | null
      readonly kind: RuntimeHookKind
      readonly ordinal: number
      /** `null` when the hook succeeded. */
      readonly error: SerializedError | null
      readonly t: number
    }
  | {
      readonly type: 'annotation'
      readonly testId: TaskId
      readonly message: string
      readonly kind: string
      readonly location: SourceLocation | null
      readonly t: number
    }
  | {
      readonly type: 'console'
      /**
       * The task running when the write happened, from the current-test lookup: the test (also
       * during its each-hooks), the suite or file whose `beforeAll`/`afterAll` ran, or `null`
       * outside any task.
       */
      readonly taskId: TaskId | null
      readonly stream: 'stdout' | 'stderr'
      /** The console method (`log`, `warn`, …), or `null` for a direct stream write. */
      readonly level: string | null
      readonly text: string
      /** Where the console call was made, when captured (Jest's `origin`). */
      readonly origin: string | null
      readonly t: number
    }
  | {
      readonly type: 'unhandled-error'
      /** The task the error is charged to, or `null` when it is charged to the run. */
      readonly ownerId: TaskId | null
      readonly lastTestId: TaskId | null
      readonly origin: UnhandledErrorOrigin
      readonly error: SerializedError
      readonly t: number
    }
  | {
      readonly type: 'file-end'
      readonly fileId: TaskId
      readonly result: TaskResult
      readonly t: number
    }

/**
 * A runtime event type.
 * @public
 */
export type RuntimeEventType = RuntimeEvent['type']

/**
 * The runtime events of the given type(s): `RuntimeEventOf<'test-end'>`.
 * @public
 */
export type RuntimeEventOf<Type extends RuntimeEventType> = Extract<
  RuntimeEvent,
  { readonly type: Type }
>

/**
 * Where the runtime sends its events, one at a time, in order. The worker's packer (Track 9)
 * batches them; the core never does.
 * @public
 */
export interface EventSink {
  emit(event: RuntimeEvent): void
}
