// T2.4 / DECISIONS D10: the stopgap module-runner rewrite. This is the only caller of oxc's
// deprecated `moduleRunnerTransformSync` ("Only works for Vite"). It aborts the whole process on
// unstripped TypeScript, so it only ever sees the pipeline's stripped output, and any error it
// reports becomes a per-file `TransformError`. Track 3's own transform (T3.13, B20) replaces it.
import type { SourceMapV3, TransformRecord } from '@provino/types'
import { moduleRunnerTransformSync } from 'oxc-transform'
import { TransformError } from './errors.ts'
import { composeMaps, toSourceMapV3 } from './internal/maps.ts'

/**
 * A module in module-runner form: imports become `__vite_ssr_import__` calls and exports become
 * getters on `__vite_ssr_exports__`.
 * @beta
 */
export interface ModuleRunnerOutput {
  readonly code: string
  /** From the runner form back to the original source. */
  readonly map: SourceMapV3 | null
  /** Static import specifiers, in source order. */
  readonly deps: readonly string[]
  readonly dynamicDeps: readonly string[]
}

/**
 * Rewrites a transformed ESM module into module-runner form. `record` must come from the
 * pipeline (TypeScript already stripped). Errors are thrown as `TRANSFORM_RUNNER_FAILED`,
 * naming the file.
 * @beta
 */
export function toModuleRunner(filename: string, record: TransformRecord): ModuleRunnerOutput {
  let result: ReturnType<typeof moduleRunnerTransformSync>
  try {
    result = moduleRunnerTransformSync(filename, record.code, { sourcemap: true })
  } catch (error) {
    throw new TransformError(
      'TRANSFORM_RUNNER_FAILED',
      `the module-runner transform failed on ${filename}`,
      { cause: error },
    )
  }
  const [first] = result.errors
  if (first !== undefined) {
    throw new TransformError(
      'TRANSFORM_RUNNER_FAILED',
      `the module-runner transform failed on ${filename}: ${first.message}`,
    )
  }
  return {
    code: result.code,
    map: composeMaps([record.map, result.map === undefined ? null : toSourceMapV3(result.map)]),
    deps: result.deps,
    dynamicDeps: result.dynamicDeps,
  }
}
