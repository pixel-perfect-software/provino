// Runs one runtime-corpus test file through `@provino/core` (B07's temporary entry before
// `provino/node` exists, DECISIONS S4) and reduces the events to what a golden records: the trace,
// each test's title path, `dupIndex`, status, location and whether it carries errors, and the
// file's status, whether it carries errors, and what failed at collection.
import { pathToFileURL } from 'node:url'
import { createRuntime } from '@provino/core'
import { createBehaviourLoader } from '@provino/policy'
import type {
  CorePolicy,
  RuntimeEvent,
  RuntimeEventOf,
  RuntimeEventType,
  SerializedError,
  TaskId,
  TaskNode,
  TaskResult,
  TaskState,
  TestTask,
} from '@provino/types'
import { installGlobals } from '../internal/globals.ts'

/**
 * A task state as the result model names it. `no-result` is a task the core never reported an
 * ending for (or left `queued` or `running`): no golden has that status, so it never matches.
 */
export type Reported = 'passed' | 'failed' | 'skipped' | 'todo' | 'no-result'

/** A test as the comparison sees it. */
export interface CoreTest {
  readonly path: readonly string[]
  readonly dupIndex: number
  readonly status: Reported
  readonly location: { readonly line: number; readonly column: number } | null
  /** What its `test-end` result reports. The comparison only asks whether there are any. */
  readonly errors: readonly SerializedError[]
}

/** One file's run under the core. */
export interface CoreRun {
  readonly trace: readonly string[]
  readonly tests: readonly CoreTest[]
  /**
   * `crashed` is a failed file with no tasks and a collection error. The result model has no file
   * status for a file of only todos, so `todo` matches no golden until a fixture records one.
   */
  readonly fileStatus: 'crashed' | Reported
  /** The errors on the `file-end` result: what the golden calls `fileError`. */
  readonly fileErrors: readonly SerializedError[]
  /** The errors on the `file-collect-end` event: what stopped the file from collecting. */
  readonly collectionErrors: readonly SerializedError[]
  /**
   * The `unhandled-error` events: who each was charged to (`'run'`, `'file'`, or a test's title
   * path), where it came from and its error. A test charged one has the error in `errors` and is
   * `failed` here, as a consumer of the events shows it.
   */
  readonly unhandled: ReadonlyArray<{
    readonly chargedTo: 'run' | 'file' | readonly string[]
    readonly origin: string
    readonly error: SerializedError
  }>
}

let imports = 0

/**
 * Runs `file` (absolute) under `policy`, with every key of `runtime.api`, so a new API function
 * needs no list here, and `trace` installed as globals for the duration, as the recorder's runners
 * would. `rootDir` is the fixture directory.
 */
export async function runUnderCore(
  file: string,
  rootDir: string,
  policy: CorePolicy,
  options: { readonly processErrors?: boolean } = {},
): Promise<CoreRun> {
  const events: RuntimeEvent[] = []
  const trace: string[] = []
  const runtime = await createRuntime({
    policy,
    behaviours: createBehaviourLoader(),
    sink: { emit: (event) => events.push(event) },
    // A fresh module instance per run: the query makes each import a new URL.
    importFile: (path) => import(`${pathToFileURL(path).href}?core-run=${++imports}`),
    rootDir,
    // The recorder runs both runners with `CI=1`.
    ci: true,
  })
  // Like the recorder's `trace`, it returns nothing: a test arrow that returns its result must not
  // trip `nonPromiseReturn`.
  const restore = installGlobals({
    trace: (step: string): void => {
      trace.push(step)
    },
    ...runtime.api,
  })
  // The process's own listeners, for the fixtures whose errors come from timers and rejections: a
  // test process (`node:test`) has its own handlers, so those run in a child (`child.ts`).
  const stop = options.processErrors === true ? runtime.captureProcessErrors() : undefined
  try {
    await runtime.runFile(file)
  } finally {
    stop?.()
    restore()
    await runtime.dispose()
  }
  return summarizeRun(events, trace)
}

function findEvent<Type extends RuntimeEventType>(
  events: readonly RuntimeEvent[],
  type: Type,
): RuntimeEventOf<Type> | undefined {
  return events.find((event): event is RuntimeEventOf<Type> => event.type === type)
}

/** The result model's name for a task's final state. */
export function reported(state: TaskState | undefined): Reported {
  switch (state) {
    case 'pass':
      return 'passed'
    case 'fail':
      return 'failed'
    case 'skip':
      return 'skipped'
    case 'todo':
      return 'todo'
    case 'queued':
    case 'running':
    case undefined:
      return 'no-result'
  }
}

/**
 * Reduces what the core emitted for one file to a `CoreRun`. A collected test with no `test-end`
 * is `no-result`, and so is a file with no `file-end`: a core that drops an ending must fail the
 * comparison, not read as a skipped test.
 */
export function summarizeRun(events: readonly RuntimeEvent[], trace: readonly string[]): CoreRun {
  const collected = findEvent(events, 'file-collect-end')
  const fileEnd = findEvent(events, 'file-end')
  const tasks: readonly TaskNode[] = collected?.tasks ?? []
  const results = new Map<TaskId, TaskResult>()
  for (const event of events) {
    if (event.type === 'test-end') results.set(event.id, event.result)
  }
  const charged = new Map<TaskId, SerializedError[]>()
  const unhandled: Array<CoreRun['unhandled'][number]> = []
  for (const event of events) {
    if (event.type !== 'unhandled-error') continue
    const owner = tasks.find((task) => task.id === event.ownerId)
    const chargedTo =
      owner === undefined || event.ownerId === null
        ? 'run'
        : owner.type === 'test'
          ? owner.fullName
          : 'file'
    unhandled.push({ chargedTo, origin: event.origin, error: event.error })
    if (event.ownerId !== null && owner?.type === 'test') {
      charged.set(event.ownerId, [...(charged.get(event.ownerId) ?? []), event.error])
    }
  }
  const tests = tasks
    .filter((task): task is TestTask => task.type === 'test')
    .map((task): CoreTest => {
      const result = results.get(task.id)
      const late = charged.get(task.id) ?? []
      return {
        path: task.fullName,
        dupIndex: task.dupIndex,
        status: late.length > 0 ? 'failed' : reported(result?.state),
        location:
          task.location === null
            ? null
            : { line: task.location.line, column: task.location.column },
        errors: [...(result?.errors ?? []), ...late],
      }
    })
  const collectionErrors = collected?.errors ?? []
  const status = reported(fileEnd?.result.state)
  const crashed = status === 'failed' && tests.length === 0 && collectionErrors.length > 0
  return {
    trace,
    tests,
    fileStatus: crashed ? 'crashed' : status,
    fileErrors: [
      ...(fileEnd?.result.errors ?? []),
      ...unhandled.filter((item) => item.chargedTo === 'file').map((item) => item.error),
    ],
    collectionErrors,
    unhandled,
  }
}
