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
  /**
   * Aborting stops the run: no file starts, running ones are killed, and the exit code is 130
   * (143 when it is aborted with the reason `'SIGTERM'`, as the bin does for that signal).
   */
  readonly signal?: AbortSignal
  /**
   * Aborting kills every worker at once, without waiting for one that is stopping slowly (the
   * second Ctrl+C), and aborts the run as `signal` does.
   */
  readonly forceSignal?: AbortSignal
  /**
   * End the run once this many tests have failed (`--bail`). When it is checked, after each file
   * or after each test, is the dialect's. Files still running are killed and not reported.
   */
  readonly bail?: number
  /**
   * Report what is still open after the last file, and where it was made (`--detectOpenHandles`).
   * It runs the files in this process (`pool: 'inline'`), and slows every timer and socket they
   * make.
   */
  readonly detectOpenHandles?: boolean
  /**
   * Replace a worker once it holds more than this many bytes after a file (`0`: after every
   * file). Default: `max(512 MiB, 25% of the memory / maxWorkers)`; `Infinity` turns it off.
   */
  readonly workerMemoryLimit?: number
  /** Replace a worker after it has run this many files. Default: never. */
  readonly maxFilesPerWorker?: number
  /**
   * Kill a worker that runs one file for more than this many ms, and fail the file. Default:
   * none (a test's own timeout can't stop a synchronous loop).
   */
  readonly fileTimeoutMs?: number
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
