// What a worker holds after a file, and the one forced collection that decides whether the pool
// replaces it (`RecyclePolicy.memoryLimitBytes`). The collector is shared with the leak check
// (`runtime/leaks.ts`), so the flag dance exists once in the worker node.
import { getHeapStatistics, setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'

/**
 * Forces one full garbage collection, whether or not `node --expose-gc` is on. `gc` is reached
 * through a fresh context made while `--expose-gc` is set (as `jest-leak-detector` does), and the
 * flag goes back to off if it was off before, so no context made later sees a `gc` of its own.
 * @internal
 */
export function collectGarbage(): void {
  const hidden = globalThis.gc === undefined
  setFlagsFromString('--expose-gc')
  const gc: unknown = runInNewContext('gc')
  if (typeof gc === 'function') gc()
  if (hidden) setFlagsFromString('--no-expose-gc')
}

/**
 * The heap the worker's isolate holds, `used_heap_size`: what jest-worker compares against
 * `workerIdleMemoryLimit` (`processChild` and `threadChild` both read
 * `process.memoryUsage().heapUsed`). RSS is not compared, in a fork or anywhere: a fresh fork sits
 * near 200 MB of it with about 70 MB of heap, so a 1 GB limit would replace its worker every few
 * files. `external` is no better: it counts what the isolate has reserved, not what it holds
 * (oxc-parser's raw transfer buffer is a 6 GiB `ArrayBuffer` of virtual memory). Nothing is
 * collected first: this is what is held right now, garbage included.
 * @internal
 */
export function usedHeapBytes(): number {
  return getHeapStatistics().used_heap_size
}

/**
 * The memory a worker reports after a file (`fileDone.memoryBytes`), which the pool compares with
 * the same `limitBytes` (`WorkerInit.memoryLimitBytes`) to decide whether to replace the worker.
 *
 * A heap over the limit is collected once and measured again, and the second number is the report:
 * a worker is replaced for what it still holds after its garbage is gone, not for the garbage a
 * file left that V8 has not got to yet (D115, `speed`: a replacement costs the module records and
 * compiled wrappers every worker loads for itself, about 5 s for a React UI suite, `local`). Only
 * a worker over its limit pays for the collection, while it is idle between files: 69 ms median
 * (range 55 to 148, 7 fresh processes) for a heap of 953 MiB with 301 MiB of it live, down to 282
 * MiB (`local`, Node 24.22.1, a machine under load). Jest compares the heap as it is (jest-worker
 * 30.5.1, `processChild.js`: `process.memoryUsage().heapUsed`, no collection), so a worker Jest
 * replaces because of garbage is kept here (DIVERGENCES: collect before recycling). A test can't
 * tell: `JEST_WORKER_ID` and the files a worker runs are the same.
 *
 * No collection happens without a limit, or with a limit of `0` (replace after every file: the
 * answer doesn't depend on the heap), or with a heap at or under the limit. A collection that
 * can't run leaves the first reading as the report (what Jest compares), never a lost `fileDone`:
 * V8's flags are process-wide, so a worker thread that restores `--no-expose-gc` between another's
 * set and its new context leaves that one without a `gc`.
 * @internal
 */
export function memoryAfterFile(
  limitBytes: number | undefined,
  read: () => number = usedHeapBytes,
  collect: () => void = collectGarbage,
): number {
  const used = read()
  if (limitBytes === undefined || limitBytes <= 0 || used <= limitBytes) return used
  try {
    collect()
  } catch {
    return used
  }
  return read()
}
