// T8.8, Istanbul side: the counters the instrumented modules write into the worker's global. A
// module is compiled once per worker and its counters object is captured by the code, so each
// file's take copies the counters out and zeroes them in place (never replaces the object).
import type { CoverageCollector, IstanbulFileCoverageData, RawCoverage } from '@provino/types'
import { createMapInterner } from './intern.ts'

/**
 * Options of `createIstanbulCollector`.
 * @public
 */
export interface IstanbulCollectorOptions {
  readonly workerId: number
  /** The global the counters live in (`istanbulVariable`). Default `__coverage__`. */
  readonly variable?: string
}

function isCoverageData(value: unknown): value is IstanbulFileCoverageData {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'path') === 'string' &&
    typeof Reflect.get(value, 's') === 'object' &&
    typeof Reflect.get(value, 'f') === 'object' &&
    typeof Reflect.get(value, 'b') === 'object'
  )
}

/** Whether every counter is zero. */
function untouched(data: IstanbulFileCoverageData): boolean {
  for (const hits of Object.values(data.s)) if (hits !== 0) return false
  for (const hits of Object.values(data.f)) if (hits !== 0) return false
  for (const hits of Object.values(data.b)) if (hits.some((count) => count !== 0)) return false
  return true
}

/** Zeroes the counters of a live coverage object where they are. */
function reset(live: {
  s: Record<string, number>
  f: Record<string, number>
  b: Record<string, number[]>
}): void {
  for (const key of Object.keys(live.s)) live.s[key] = 0
  for (const key of Object.keys(live.f)) live.f[key] = 0
  for (const key of Object.keys(live.b)) {
    const branch = live.b[key]
    if (branch !== undefined) branch.fill(0)
  }
}

/**
 * A collector over the worker's `__coverage__`. `take(testFile)` returns what the instrumented
 * modules counted since the last take and starts them at zero again; a file the take finds
 * untouched, whose maps went out before, is left out. The first take of a file carries its maps.
 * @public
 */
export function createIstanbulCollector(options: IstanbulCollectorOptions): CoverageCollector {
  const variable = options.variable ?? '__coverage__'
  const interner = createMapInterner()
  return {
    start: () => Promise.resolve(),
    take(testFile) {
      const global: Record<string, unknown> = globalThis as unknown as Record<string, unknown>
      const live: unknown = global[variable]
      const data: Record<string, unknown> = {}
      if (typeof live === 'object' && live !== null) {
        for (const [path, entry] of Object.entries(live)) {
          if (!isCoverageData(entry)) continue
          // A copy first: the counters go back to zero in place straight after.
          const copy = structuredClone(entry)
          if (interner.has(copy.path, copy.hash) && untouched(copy)) continue
          data[path] = interner.compact(copy)
          reset(entry as unknown as Parameters<typeof reset>[0])
        }
      }
      const raw: RawCoverage = {
        kind: 'istanbul',
        workerId: options.workerId,
        ...(testFile === undefined ? {} : { testFile }),
        data,
      }
      return Promise.resolve(raw)
    },
    stop: () => Promise.resolve(),
  }
}
