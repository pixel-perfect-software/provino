// What Jest does with the run's results once the run is over: `processResults` (jest-core 30.5.2
// `runJest.ts` L173-L213). The `testResultsProcessor` replaces the results, then `--json` writes
// them (to `--outputFile`, resolved against the real working directory, or to stdout) and Jest
// says where it wrote them on its output stream.
import { realpath, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { ConfigError } from '@provino/config'
import {
  type AggregatedResult,
  formatJson,
  serializeToJson,
  type TestResultsProcessor,
} from '@provino/dialect-jest/results'
import { requireOrImportModule } from '../load.ts'

/**
 * What `processJestResults` needs.
 * @public
 */
export interface ProcessJestResultsOptions {
  readonly aggregated: AggregatedResult
  readonly globalConfig: {
    readonly json: boolean
    readonly outputFile: string | undefined
    readonly testResultsProcessor: string | undefined
    readonly testFailureExitCode: number
  }
  /** The working directory the output file is resolved against. */
  readonly cwd: string
  /** Where `--json` without an output file goes. */
  readonly stdout: { write(text: string): unknown }
  /** Jest's output stream: stderr under `--json` or `--useStderr`, else stdout. */
  readonly outputStream: { write(text: string): unknown }
}

/**
 * Runs the processor, writes the JSON, and returns whether the run succeeded (the processor's
 * results decide, as in Jest).
 * @public
 */
export async function processJestResults(options: ProcessJestResultsOptions): Promise<boolean> {
  const { globalConfig } = options
  // A processor may return nothing at all (Jest types it as `any`): with `--json` that throws
  // in `formatTestResults`, as in Jest; without it the run is judged successful (jest-cli
  // `readResultsAndExit`: `!result || result.success`).
  let results: AggregatedResult | undefined = options.aggregated
  if (globalConfig.testResultsProcessor !== undefined) {
    const processor = (await loadProcessor(
      globalConfig.testResultsProcessor,
    )) as TestResultsProcessor
    results = await processor(options.aggregated)
  }
  if (globalConfig.json) {
    const text = serializeToJson(formatJson(results as AggregatedResult))
    const { outputFile } = globalConfig
    if (outputFile !== undefined && outputFile !== '') {
      const cwd = await realpath(options.cwd).catch(() => options.cwd)
      const file = resolve(cwd, outputFile)
      await writeFile(file, `${text}\n`)
      await options.outputStream.write(`Test results written to: ${relative(cwd, file)}\n`)
    } else {
      await options.stdout.write(`${text}\n`)
    }
  }
  return !results || results.success
}

/**
 * Imports the processor. A module that throws as it loads is the user's own error, which Jest
 * lets out of `runJest` as it is (exit 1, the stack): the config loader's wrapper is taken off.
 */
async function loadProcessor(path: string): Promise<unknown> {
  try {
    return await requireOrImportModule(path)
  } catch (error) {
    if (error instanceof ConfigError && error.code === 'CONFIG_LOAD_FAILED' && error.cause) {
      throw error.cause
    }
    throw error
  }
}
