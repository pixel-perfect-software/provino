import type { TextSink } from '@provino/reporters'
import type { PoolKind, Reporter, RunSummary } from '@provino/types'

/**
 * The options the `normalized-json` reporter takes through `run()`.
 * @public
 */
export interface NormalizedJsonChoiceOptions {
  /** Where the JSON goes, relative to `cwd`; its directory is created. Default: `stdout`. */
  readonly outputFile?: string
  /** The corpus id, `NormalizedRun.suite`. Default: the project root's directory name. */
  readonly suite?: string
}

/**
 * One reporter for `run()`: a built-in by name, `normalized-json` with options, or a reporter
 * object (`defineReporter` from `@provino/reporters`).
 * @public
 */
export type ReporterChoice =
  | 'default'
  | 'normalized-json'
  | readonly ['normalized-json', NormalizedJsonChoiceOptions]
  | Reporter

/**
 * What `run()` takes.
 * @public
 */
export interface RunOptions {
  /** The config file, resolved against `cwd`. */
  readonly config: string
  /** Where relative paths (`config`, an `outputFile`) start. Default: `process.cwd()`. */
  readonly cwd?: string
  /** Default: one fewer than the machine's available parallelism, at least 1. */
  readonly maxWorkers?: number
  /** Default: the policy's `orchestrator.pool.default`. */
  readonly pool?: PoolKind
  /** Default: the policy's `report.defaultReporters`, each a built-in name. */
  readonly reporters?: readonly ReporterChoice[]
  /** Whether this is a CI run. Default: the `CI` environment variable is set, and not `false` or `0`. */
  readonly ci?: boolean
  /** A run that finds no test files passes. Default: the policy's `orchestrator.passWithNoTests`. */
  readonly passWithNoTests?: boolean
  /** Run only the tests whose full name matches this regular expression (`-t`). */
  readonly testNamePattern?: string
  /** Rewrite the snapshots that differ (`-u`). Default: write new ones, and none in a CI run. */
  readonly updateSnapshot?: boolean
  /** Order the run by, and record it in, the results cache. Default `true`. */
  readonly cache?: boolean
  /** Where the `normalized-json` reporter writes without an `outputFile`. Default: `process.stdout`. */
  readonly stdout?: TextSink
  /** Where the `default` reporter, usage errors and the workers' own stderr go. Default: `process.stderr`. */
  readonly stderr?: NodeJS.WritableStream
  /** Aborting stops the run: no file starts, running ones are killed, and the exit code is 130. */
  readonly signal?: AbortSignal
}

/**
 * How a run ended.
 * @public
 */
export interface RunResult {
  /** The process exit code the run calls for: 0, the policy's failure codes, 2 for bad input, 130 when interrupted. */
  readonly exitCode: number
  /** `null` when the run never started: a usage or config error. */
  readonly summary: RunSummary | null
}
