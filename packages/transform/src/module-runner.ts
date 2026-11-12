// T3.13 / DECISIONS D10: the module-runner rewrite, our own (`runner/`) in place of oxc's
// deprecated module-runner transform. It only ever sees the pipeline's stripped output; any
// error becomes a per-file `TransformError`, and unstripped TypeScript is a parse error.
import type { RunnerForm, SourceMapV3, TransformRecord } from '@provino/types'
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
 * Whether the loader runs a record in module-runner form (`toModuleRunner`): an ES module, or a
 * file whose only module syntax is `import()` (format `unknown`), which fails in a CommonJS `vm`
 * script and so runs as a module.
 * @beta
 */
export function usesModuleRunnerForm(record: Pick<TransformRecord, 'format' | 'imports'>): boolean {
  return (
    record.format === 'esm' ||
    (record.format === 'unknown' && record.imports.some((entry) => entry.kind === 'dynamic'))
  )
}

/**
 * Rewrites a transformed ESM module into module-runner form. `record` must come from the
 * pipeline (TypeScript already stripped). Errors are thrown as `TRANSFORM_RUNNER_FAILED`,
 * naming the file. Deterministic: the same record gives the same bytes.
 * @beta
 */
export function toModuleRunner(filename: string, record: TransformRecord): ModuleRunnerOutput {
  // A cached or pipeline-made runner form skips the step (`createPipeline({ runnerForm: true })`).
  const form = record.runner ?? runnerFormOf(filename, record.code)
  let composed: SourceMapV3 | null | undefined
  return {
    code: form.code,
    get map(): SourceMapV3 | null {
      if (composed === undefined) {
        composed = composeMaps([
          record.map,
          toSourceMapV3(mapOfEdits(filename, record.code, form.edits)),
        ])
      }
      return composed
    },
    deps: form.deps,
    dynamicDeps: form.dynamicDeps,
  }
}

/** The module-runner form of `code`, or the per-file `TRANSFORM_RUNNER_FAILED` error. */
function runnerFormOf(filename: string, code: string): RunnerForm {
  try {
    return rewriteModule(filename, code)
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
}
