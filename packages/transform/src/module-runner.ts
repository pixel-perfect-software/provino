// T3.13 / DECISIONS D10: the module-runner rewrite, our own (`runner/`) in place of oxc's
// deprecated `moduleRunnerTransformSync`. It only ever sees the pipeline's stripped output; any
// error becomes a per-file `TransformError`, and unstripped TypeScript is a parse error.
import type { SourceMapV3, TransformRecord } from '@provino/types'
import { TransformError } from './errors.ts'
import { composeMaps, toSourceMapV3 } from './internal/maps.ts'
import { mapOfEdits, RunnerParseError, rewriteModule } from './runner/apply.ts'

/**
 * A module in module-runner form: imports become `__vite_ssr_import__` calls and exports become
 * getters on `__vite_ssr_exports__`.
 * @beta
 */
export interface ModuleRunnerOutput {
  readonly code: string
  /**
   * From the runner form back to the original source. Composed on first read (it costs a JSON
   * round trip and a remap, and a warm run almost never asks).
   */
  readonly map: SourceMapV3 | null
  /** Static import specifiers, in source order. */
  readonly deps: readonly string[]
  readonly dynamicDeps: readonly string[]
}

/**
 * Rewrites a transformed ESM module into module-runner form. `record` must come from the
 * pipeline (TypeScript already stripped). Errors are thrown as `TRANSFORM_RUNNER_FAILED`,
 * naming the file. Deterministic: the same record gives the same bytes.
 * @beta
 */
export function toModuleRunner(filename: string, record: TransformRecord): ModuleRunnerOutput {
  let result: ReturnType<typeof rewriteModule>
  try {
    result = rewriteModule(filename, record.code)
  } catch (error) {
    if (error instanceof RunnerParseError) {
      throw new TransformError(
        'TRANSFORM_RUNNER_FAILED',
        `the module-runner transform failed on ${filename}: ${error.message}`,
      )
    }
    throw new TransformError(
      'TRANSFORM_RUNNER_FAILED',
      `the module-runner transform failed on ${filename}`,
      { cause: error },
    )
  }
  const { edits } = result
  const input = record.code
  let composed: SourceMapV3 | null | undefined
  return {
    code: result.code,
    get map(): SourceMapV3 | null {
      if (composed === undefined) {
        composed = composeMaps([record.map, toSourceMapV3(mapOfEdits(filename, input, edits))])
      }
      return composed
    },
    deps: result.deps,
    dynamicDeps: result.dynamicDeps,
  }
}
