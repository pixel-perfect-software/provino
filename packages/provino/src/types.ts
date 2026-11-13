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
 * The options the `junit` reporter takes through `run()`.
 * @public
 */
export interface JUnitChoiceOptions {
  /** Where the XML goes, relative to `cwd`; its directory is created. Default: `stdout`. */
  readonly outputFile?: string
  /** The `name` of `<testsuites>`. Default: `provino`. */
  readonly name?: string
}

/**
 * One reporter for `run()`: a built-in by name, `json` (or its older name `normalized-json`) or
 * `junit` with options, or a reporter object (`defineReporter` from `@provino/reporters`).
 *
 * - `default`, `verbose`, `dot`, `agent`: text on `stderr`.
 * - `json`, `normalized-json`: the `NormalizedRun` document, on `stdout` or in `outputFile`.
 * - `junit`: JUnit XML, on `stdout` or in `outputFile`.
 * - `github-actions`: error annotations on `stderr`.
 * - `summary`: the totals alone, on `stderr`.
 * @public
 */
export type ReporterChoice =
  | 'default'
  | 'verbose'
  | 'dot'
  | 'agent'
  | 'github-actions'
  | 'summary'
  | 'json'
  | 'normalized-json'
  | 'junit'
  | readonly ['json' | 'normalized-json', NormalizedJsonChoiceOptions]
  | readonly ['junit', JUnitChoiceOptions]
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
  /**
   * Default: the policy's `report.defaultReporters`, each a built-in name; `agent` in place of
   * `default` when an agent runs the process, and `github-actions` added on GitHub Actions.
   */
  readonly reporters?: readonly ReporterChoice[]
  /** Whether this is a CI run. Default: the `CI` environment variable is set, and not `false` or `0`. */
  readonly ci?: boolean
  /**
   * The environment the run reads: `CI`, the variables that say an agent runs it (`CLAUDECODE`,
   * `AI_AGENT`, ...), `GITHUB_ACTIONS`, `FORCE_COLOR`, `NO_COLOR` and `TERM`. They choose the
   * reporters when `reporters` names none (`agent` for an agent, `github-actions` beside the
   * default on GitHub Actions) and whether the `default` reporter colours its text and draws a live
   * block. Default: `process.env`.
   */
  readonly env?: Readonly<Record<string, string | undefined>>
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
   * (143 when it is aborted with the reason `'SIGTERM'`, 129 for `'SIGHUP'`: the bin's own codes).
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
  /**
   * Run only shard `index` of `count` of the test files (`--shard=2/5`, 1-based). With a timings
   * file (`provino.timings.json`, or `timingsFile`) the shards are contiguous runs of the
   * path-sorted files cut by predicted time; without one, the dialect's split (Jest's sha1 split
   * under the Jest dialect, path-sorted slices by count otherwise).
   */
  readonly shard?: { readonly index: number; readonly count: number }
  /** The timings file `shard` cuts by and `updateTimings` writes. Default: `provino.timings.json` in the project root. */
  readonly timingsFile?: string
  /**
   * After the run, write each file that ran, with its time, into the timings file
   * (`--update-timings`). Not together with `shard` (a usage error, exit 2): refresh the file on
   * an unsharded run.
   */
  readonly updateTimings?: boolean
}

/**
 * How a run ended.
 * @public
 */
export interface RunResult {
  /** The process exit code the run calls for: 0, the policy's failure codes, 2 for bad input, 128 plus the signal's number when one ended it (130, 143, 129). */
  readonly exitCode: number
  /** `null` when the run never started: a usage or config error. */
  readonly summary: RunSummary | null
}
