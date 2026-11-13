// `onCleanup` callbacks, last in first out, at the end of the value's scope: a test run's teardowns
// (core runs them after `afterEach`), one teardown per file, and one per worker.
import type { FileHandle, LazyFrame } from '@provino/types'
import { type Engine, FILE_CLEANUPS, type LazyEntry, WORKER_STATE } from './state.ts'

/** A scope's callbacks, drained last first. */
class CleanupList {
  readonly fns: Array<() => unknown> = []

  /** Runs every callback even when one fails; throws the failure, or all of them together. */
  async drain(): Promise<void> {
    const errors: unknown[] = []
    while (this.fns.length > 0) {
      const fn = this.fns.pop()
      try {
        await fn?.()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'Lazy cleanups failed')
  }
}

interface WorkerState {
  readonly list: CleanupList
  readonly controller: AbortController
}

function fileList(file: FileHandle): CleanupList {
  let list = file.slots.get(FILE_CLEANUPS) as CleanupList | undefined
  if (list === undefined) {
    const created = new CleanupList()
    list = created
    file.slots.set(FILE_CLEANUPS, created)
    file.teardowns.push(() => created.drain())
  }
  return list
}

function workerState(engine: Engine): WorkerState {
  let state = engine.host.workerSlots.get(WORKER_STATE) as WorkerState | undefined
  if (state === undefined) {
    const created: WorkerState = { list: new CleanupList(), controller: new AbortController() }
    state = created
    engine.host.workerSlots.set(WORKER_STATE, created)
    engine.host.addWorkerTeardown(() => {
      created.controller.abort()
      return created.list.drain()
    })
  }
  return state
}

/** Where a value's cleanups run: its test run, its file, or the worker. */
export function registerCleanup(
  engine: Engine,
  entry: LazyEntry,
  frame: LazyFrame,
  fn: () => unknown,
): void {
  if (entry.scope === 'worker') workerState(engine).list.fns.push(fn)
  else if (entry.scope === 'test' && frame.kind === 'test') frame.run.addTeardown(fn)
  else fileList(frame.file).fns.push(fn)
}

/** Aborted when the value's scope ends (for a worker value, at worker shutdown). */
export function scopeSignal(engine: Engine, entry: LazyEntry, frame: LazyFrame): AbortSignal {
  if (entry.scope === 'worker') return workerState(engine).controller.signal
  if (entry.scope === 'test' && frame.kind === 'test') return frame.run.signal
  return frame.file.signal
}
