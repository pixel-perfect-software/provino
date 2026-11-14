// T8.8, V8 side: a worker's precise coverage, taken once per worker (D109). The profiler starts
// before anything of the project loads, so every script a test file evaluates is counted, and the
// take at `stop` keeps the scripts that are user modules the loader compiled and the filter counts.
// Offsets are the script's own; `Loader.compiledModule` gives the wrapper that precedes the code.
import { Session } from 'node:inspector/promises'
import type {
  CoverageCollector,
  ExecutedModuleInfo,
  Loader,
  RawCoverage,
  V8ScriptCoverage,
} from '@provino/types'

/**
 * Options of `createV8Collector`.
 * @public
 */
export interface V8CollectorOptions {
  readonly workerId: number
  /** The worker's loader: a script it did not compile is not a user module. */
  readonly loader: Pick<Loader, 'compiledModule'>
  /** Whether the module at this absolute path counts (`createCoverageFilter`). */
  readonly include: (path: string) => boolean
  /** Count calls, not only hits (`v8HitCounts`): V8's `callCount`. */
  readonly callCount: boolean
}

/**
 * A collector over `node:inspector`'s precise coverage. `take` returns every counted script and
 * resets V8's counters, so the worker takes once, when it stops.
 * @public
 */
export function createV8Collector(options: V8CollectorOptions): CoverageCollector {
  const session = new Session()
  let started = false
  return {
    async start() {
      if (started) return
      session.connect()
      started = true
      await session.post('Profiler.enable')
      await session.post('Profiler.startPreciseCoverage', {
        callCount: options.callCount,
        detailed: true,
      })
    },
    async take(testFile) {
      const { result } = await session.post('Profiler.takePreciseCoverage')
      const scripts: V8ScriptCoverage[] = []
      const modules = new Map<string, ExecutedModuleInfo>()
      for (const script of result) {
        const { url } = script
        // V8 names a user module's script by the `file:` URL of its path.
        if (!url.startsWith('file:')) continue
        const compiled = options.loader.compiledModule?.(url)
        if (compiled === null || compiled === undefined || !options.include(compiled.path)) continue
        scripts.push(script)
        modules.set(url, {
          url,
          wrapperLength: compiled.wrapperLength,
          transformKey: compiled.transformKey,
          code: compiled.code,
          map: compiled.map,
        })
      }
      const raw: RawCoverage = {
        kind: 'v8',
        workerId: options.workerId,
        ...(testFile === undefined ? {} : { testFile }),
        scripts,
        modules: [...modules.values()],
      }
      return raw
    },
    async stop() {
      if (!started) return
      started = false
      try {
        await session.post('Profiler.stopPreciseCoverage')
        await session.post('Profiler.disable')
      } finally {
        session.disconnect()
      }
    },
  }
}
