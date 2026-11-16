// Decision D22: a global a file leaves behind that the environment can't remove is a warning, not
// a failure. The environment's `teardown` returns an `EnvironmentTeardownReport` naming the keys;
// this reads it and builds the `console` event the worker sends for it.
import { getHeapSnapshot } from 'node:v8'
import type { RuntimeEventOf } from '@provino/types'
import { WorkerError } from '../../errors.ts'
import { collectGarbage } from '../memory.ts'
import { isRecord, isStringArray } from './guards.ts'

/**
 * The keys a `teardown` reported it could not remove. A clean teardown returns nothing (or
 * anything that is not a report), which is no keys. A value that has a `leakedGlobals` key must be
 * an array of strings: an environment that tried to report and got the shape wrong is
 * `ORCH_BAD_ENVIRONMENT`, charged to the file like any teardown failure.
 * @internal
 */
export function leakedGlobalsOf(report: unknown, environmentName: string): readonly string[] {
  if (!isRecord(report) || !('leakedGlobals' in report)) return []
  const { leakedGlobals } = report
  if (!isStringArray(leakedGlobals)) {
    throw new WorkerError(
      'ORCH_BAD_ENVIRONMENT',
      `The environment "${environmentName}" returned a teardown report whose leakedGlobals is not an array of strings`,
    )
  }
  return leakedGlobals
}

/**
 * The shared modules a `teardown` reported the file left holding its own work
 * (`EnvironmentTeardownReport.perFileModules`): none when the report has no such key. A value that
 * is not an array of strings is `ORCH_BAD_ENVIRONMENT`, as for `leakedGlobals`.
 * @internal
 */
export function perFileModulesOf(report: unknown, environmentName: string): readonly string[] {
  if (!isRecord(report) || report.perFileModules === undefined) return []
  const { perFileModules } = report
  if (!isStringArray(perFileModules)) {
    throw new WorkerError(
      'ORCH_BAD_ENVIRONMENT',
      `The environment "${environmentName}" returned a teardown report whose perFileModules is not an array of strings`,
    )
  }
  return perFileModules
}

const globals = (keys: readonly string[]): string =>
  `${keys.length} ${keys.length === 1 ? 'global' : 'globals'}`

/**
 * The `console` event for a warning: level `warn`, on stderr, charged to no task. It has the
 * fields the console capture gives a `console.warn` call, so a reporter treats it the same. (It is
 * built by hand because `console.warn` would indent it inside a `console.group` that is open.)
 */
function leakWarningEvent(text: string): RuntimeEventOf<'console'> {
  return {
    type: 'console',
    taskId: null,
    stream: 'stderr',
    level: 'warn',
    text,
    origin: null,
    t: performance.now(),
  }
}

/**
 * The warning for a file whose (file-scoped) teardown left `keys` behind. It names the file and
 * the keys, and says what the cost is: the next files in this worker see them.
 * @internal
 */
export function fileLeakEvent(file: string, keys: readonly string[]): RuntimeEventOf<'console'> {
  return leakWarningEvent(
    `Provino: ${file} left ${globals(keys)} behind that the environment could not remove: ${keys.join(', ')}. Later files in this worker can see ${keys.length === 1 ? 'it' : 'them'}.\n`,
  )
}

/**
 * The warning for a worker-scoped environment (isolation `none`) whose teardown at `stop` left
 * `keys` behind.
 * @internal
 */
export function workerLeakEvent(keys: readonly string[]): RuntimeEventOf<'console'> {
  return leakWarningEvent(
    `Provino: the environment could not remove ${globals(keys)} when the worker stopped: ${keys.join(', ')}.\n`,
  )
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * `--detectLeaks` (jest-leak-detector 30.5.2's `isLeaking`, with `LeakDetector`'s finalization
 * registry replaced by `WeakRef`s): a check that holds `targets` only weakly and, when asked,
 * collects garbage, waits ten ticks, and says whether any of them is still reachable. A caller
 * makes it where the targets are in scope and calls it after every frame that held them has
 * returned. It is a function here, not a closure at the call site, so the weak references are the
 * only thing it keeps alive: a closure made inline would share a context with the file's own
 * locals. The check gives up (`false`) when `signal` aborts, so a cancelled file is not waited
 * for. `collect` is the garbage collector call, a parameter for the tests.
 */
export function createLeakCheck(
  targets: readonly object[],
  collect: () => void = collectGarbage,
): (signal?: AbortSignal) => Promise<boolean> {
  const refs = targets.map((target) => new WeakRef(target))
  const held = (): boolean => refs.some((ref) => ref.deref() !== undefined)
  /** Ten ticks for the collector to finish (nodejs/node#34636); `false` when `signal` aborted first. */
  const settle = async (signal: AbortSignal | undefined): Promise<boolean> => {
    for (let i = 0; i < 10; i++) {
      if (signal?.aborted === true) return false
      await tick()
    }
    return true
  }
  return async (signal) => {
    // A `WeakRef` keeps its target alive until the end of the job that made or read it (the
    // kept-objects list), and this runs in that job: one turn of the event loop lets it go.
    if (signal?.aborted === true) return false
    await tick()
    collect()
    if (!(await settle(signal))) return false
    if (!held()) return false
    // As Jest does: a heap snapshot is a harder collection than `gc()`, slow, so only when the
    // first one leaves something. Its stream is never read, so it is destroyed at once.
    getHeapSnapshot().destroy()
    if (!(await settle(signal))) return false
    return held()
  }
}

/**
 * `--logHeapUsage` (`runTest.ts` L354-L357): the heap in use, after a collection when `gc` is
 * exposed.
 */
export function heapUsedBytes(): number {
  globalThis.gc?.()
  return process.memoryUsage().heapUsed
}
