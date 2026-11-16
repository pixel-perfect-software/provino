// What a worker holds after a file, and the one forced collection that decides whether the pool
// replaces it (`RecyclePolicy.memoryLimitBytes`). The collector itself is shared with the leak
// check (`runtime/leaks.ts`): one helper, so the flag dance exists once.
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
 * a worker over its limit pays for the collection, while it is idle between files. Jest compares
 * the heap as it is (jest-worker 30.5.1, `processChild.js`: `process.memoryUsage().heapUsed`, no
 * collection), so a worker Jest replaces because of garbage is kept here (DIVERGENCES: collect
 * before recycling). A test can't tell: `JEST_WORKER_ID` and the files a worker runs are the same.
 *
 * No collection happens without a limit, or with a limit of `0` (replace after every file: the
 * answer doesn't depend on the number), or with a heap at or under the limit.
 * @internal
 */
export function memoryAfterFile(
  limitBytes: number | undefined,
  read: () => number = usedHeapBytes,
  collect: () => void = collectGarbage,
): number {
  const used = read()
  if (limitBytes === undefined || !(limitBytes > 0) || used <= limitBytes) return used
  collect()
  return read()
}
