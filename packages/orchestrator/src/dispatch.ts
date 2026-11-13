// Turns the events a worker sends into the reporter bus's events (Track 9 §Reporters, one event
// model): each `RuntimeEvent` is paired with the task node it refers to, which the file's own
// `file-collect-end` announced. `emit` is awaited inside the worker's `onEvents`, so a slow
// reporter holds back the ack of the pack, and the worker waits (back-pressure).
import type {
  FileInfo,
  FileTask,
  ReporterBus,
  SerializedError,
  SuiteTask,
  TaskId,
  TaskNode,
  TaskResult,
  TestTask,
  WorkerEvent,
} from '@provino/types'
import { createDepsTable, type DepsTable } from './deps-table.ts'
import { OrchestratorError } from './errors.ts'

/**
 * What the coordinator learned about one file from its events.
 * @public
 */
export interface FileDispatch {
  /** Hands one pack's events to the bus, in order. Rejects with `ORCH_BAD_EVENT` for an event it can't place. */
  handle(events: readonly WorkerEvent[]): Promise<void>
  /** The file's `file-end` result; `undefined` until that event has arrived. */
  readonly result: TaskResult | undefined
  /** How many tests the file collected (`file-collect-end`). */
  readonly tests: number
  /**
   * The user modules the file loaded (its `deps` event, rebuilt from the worker's table);
   * `undefined` until that event has arrived. T9.12's affected-test selection reads it.
   */
  readonly deps: readonly string[] | undefined
  /** How many tests ended `todo`. */
  readonly todo: number
}

/**
 * Options for `createFileDispatch`.
 * @public
 */
export interface FileDispatchOptions {
  readonly bus: ReporterBus
  readonly file: FileInfo
  /** Called for every unhandled error of the file, as it arrives. */
  readonly onUnhandled: (error: SerializedError) => void
  /** Called with each `coverage` event of the file (B23b); without it they are dropped. */
  readonly onCoverage?: (event: CoverageEvent) => void
  /** Called after each test of the file ends as `fail`, once reporters have heard of it. */
  readonly onTestFailed?: () => void
  /**
   * The table of the worker running the file, which outlives the file (a worker's `deps` events
   * name a path once). Without it the file has a table of its own, enough for one file.
   */
  readonly depsTable?: () => DepsTable
}

/** The `coverage` arm of a worker's events. */
type CoverageEvent = Extract<WorkerEvent, { readonly type: 'coverage' }>

function badEvent(event: WorkerEvent, why: string): OrchestratorError {
  return new OrchestratorError('ORCH_BAD_EVENT', `A worker sent a ${event.type} event ${why}`)
}

/**
 * Dispatches one file's events. Create one per file run; the task tree it builds belongs to that
 * file. Events that no reporter has a bus event for are dropped: `file-collect-start` (the
 * coordinator announces `file:start` itself), `file-end` (kept as `result`; the coordinator emits
 * `file:end` once the worker is done), and the worker's own `coverage` event (T8.x, T9.8); its
 * `deps` event is kept, rebuilt, as `deps` (T9.12).
 * @public
 */
export function createFileDispatch(options: FileDispatchOptions): FileDispatch {
  const { bus, file, onUnhandled, onTestFailed, onCoverage, depsTable } = options
  const nodes = new Map<TaskId, TaskNode>()
  let result: TaskResult | undefined
  let tests = 0
  let deps: readonly string[] | undefined
  /** The table of a file run on its own: no worker's earlier files to share ids with. */
  const ownTable = createDepsTable()
  const tableOf = depsTable ?? ((): DepsTable => ownTable)
  let todo = 0

  function node(event: WorkerEvent, id: TaskId): TaskNode {
    const found = nodes.get(id)
    if (found === undefined) throw badEvent(event, `for a task it never announced (${id})`)
    return found
  }

  function suiteOrTest(event: WorkerEvent, id: TaskId): SuiteTask | TestTask {
    const found = node(event, id)
    if (found.type === 'file') throw badEvent(event, `for the file itself (${id})`)
    return found
  }

  function test(event: WorkerEvent, id: TaskId): TestTask {
    const found = node(event, id)
    if (found.type !== 'test')
      throw badEvent(event, `for ${id}, which is a ${found.type}, not a test`)
    return found
  }

  function owner(event: WorkerEvent, id: TaskId): FileTask | SuiteTask {
    const found = node(event, id)
    if (found.type === 'test') throw badEvent(event, `for a hook owned by ${id}, which is a test`)
    return found
  }

  async function dispatch(event: WorkerEvent): Promise<void> {
    switch (event.type) {
      case 'file-collect-start':
        return
      case 'coverage':
        onCoverage?.(event)
        return
      case 'deps':
        // The worker's table takes the event in even when nothing reads the list yet: the next
        // file's ids refer to what this one added.
        deps = tableOf().resolve(event)
        return
      case 'file-collect-end':
        for (const task of event.tasks) nodes.set(task.id, task)
        tests = event.tasks.filter((task) => task.type === 'test').length
        return await bus.emit('file:collected', file, event)
      case 'suite-start':
      case 'test-start':
        return await bus.emit('task:start', suiteOrTest(event, event.id), event)
      case 'test-attempt-start':
        return await bus.emit('test:attempt-start', test(event, event.id), event)
      case 'test-attempt-end':
        return await bus.emit('test:attempt-end', test(event, event.id), event)
      case 'suite-end':
        return await bus.emit('task:end', suiteOrTest(event, event.id), event)
      case 'test-end': {
        await bus.emit('task:end', suiteOrTest(event, event.id), event)
        if (event.result.state === 'fail') onTestFailed?.()
        else if (event.result.state === 'todo') todo++
        return
      }
      case 'hook-start':
        return await bus.emit('hook:start', owner(event, event.ownerId), event)
      case 'hook-end':
        return await bus.emit('hook:end', owner(event, event.ownerId), event)
      case 'annotation':
        return await bus.emit('annotation', test(event, event.testId), event)
      case 'console':
        return await bus.emit('console', file, event)
      case 'unhandled-error':
        onUnhandled(event.error)
        // An error charged to the run, not to a task, belongs to no file.
        return await bus.emit('unhandled', event.ownerId === null ? null : file, event)
      case 'file-end':
        result = event.result
        return
      default:
        return event satisfies never
    }
  }

  return {
    async handle(events) {
      for (const event of events) await dispatch(event)
    },
    get result() {
      return result
    },
    get tests() {
      return tests
    },
    get deps() {
      return deps
    },
    get todo() {
      return todo
    },
  }
}

/**
 * Options for `createIdleDispatch`.
 * @public
 */
export interface IdleDispatchOptions {
  readonly bus: ReporterBus
  /** The file a worker ran last, if any: what its late output is shown under. */
  readonly fileOf: (workerId: number) => FileInfo | undefined
  readonly onUnhandled: (error: SerializedError) => void
  /** Called with each `coverage` event a stopping worker sends (V8's one take); without it they are dropped. */
  readonly onCoverage?: (workerId: number, event: CoverageEvent) => void
}

/**
 * Dispatches what a worker sends while it runs no file: its `console` output and unhandled errors
 * when it stops (a worker-scoped environment's teardown under isolation `none`). A console line
 * is shown under the file the worker ran last; with none, it is dropped. Any other event is a
 * bug in the worker and rejects with `ORCH_BAD_EVENT`.
 * @public
 */
export function createIdleDispatch(
  options: IdleDispatchOptions,
): (workerId: number, events: readonly WorkerEvent[]) => Promise<void> {
  const { bus, fileOf, onUnhandled, onCoverage } = options
  return async (workerId, events) => {
    const last = fileOf(workerId)
    for (const event of events) {
      switch (event.type) {
        case 'console':
          if (last !== undefined) await bus.emit('console', last, event)
          break
        case 'unhandled-error':
          onUnhandled(event.error)
          await bus.emit('unhandled', null, event)
          break
        case 'coverage':
          onCoverage?.(workerId, event)
          break
        case 'deps':
          break
        default:
          throw badEvent(event, 'while it was running no file')
      }
    }
  }
}
