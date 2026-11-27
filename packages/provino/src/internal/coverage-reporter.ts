// The coverage reporter of a run that collects coverage (B23b, T8.10): at `run:end` it writes the
// reports from `RunSummary.coverage`, as Jest's CoverageReporter does in `onRunComplete`. It sits
// where Jest's sits: after the reporters the config names and before the summary. The threshold
// failures (`CoverageSummary.thresholdFailures`, T8.11) are printed last, after the reports, and
// make the run fail (the orchestrator's exit code reads them; Jest's reporter keeps them as its
// error).
import { loadCoverageReporting } from '@provino/coverage/node'
import type { RunCoverageHooks } from '@provino/orchestrator'
import type { Environment, TextSink } from '@provino/reporters'
import type { Reporter, RunCoverageOptions, RunSummary, TextStyle } from '@provino/types'
import { outputFor, styleOf } from './reporters.ts'

/**
 * What a dialect prints around the reports (Jest's are `jestCoverageTexts`).
 * @internal
 */
export interface CoverageTexts {
  /** Said on a terminal while the files no test loaded are covered. */
  readonly untestedNotice: string
  untestedFailure(path: string, message: string, stack: string | undefined): string
  reportFailure(text: string, stack: string | undefined): string
}

/**
 * Options of `createCoverageReporter`.
 * @internal
 */
export interface CoverageReporterOptions {
  readonly options: RunCoverageOptions
  /** Where the console reports (`text`, `text-summary`) write: Jest writes them to stdout. */
  readonly stdout: TextSink
  /** Where the failures go (Jest's `console.error`). */
  readonly stderr: TextSink
  /** Whether a console report colours its numbers (Jest: stdout's colour support). */
  readonly consoleColour: boolean
  /** The failures' colour (Jest's chalk on stdout). */
  readonly style: TextStyle
  readonly texts: CoverageTexts
}

/**
 * The reporter, and the run's coverage map once its reports were written (what `--json`'s
 * `coverageMap` is; unset when the reports failed, as Jest sets it only after they are written).
 * @internal
 */
export interface CoverageReporter extends Reporter {
  coverageMap(): unknown
  /** Whether the run's coverage missed a threshold (Jest: the reporter's `getLastError()` is set). */
  thresholdsFailed(): boolean
  /** Whether the reports could not be written (what a native run turns into a failing exit code). */
  reportsFailed(): boolean
}

/**
 * Creates the coverage reporter of one run.
 * @internal
 */
export function createCoverageReporter(options: CoverageReporterOptions): CoverageReporter {
  let written: unknown
  let thresholdsMissed = false
  let reportsMissed = false
  const fail = (text: string): unknown => options.stderr.write(`${options.style.red(text)}\n`)
  return {
    name: 'coverage',
    coverageMap: () => written,
    thresholdsFailed: () => thresholdsMissed,
    reportsFailed: () => reportsMissed,
    async 'run:end'(summary: RunSummary) {
      const coverage = summary.coverage
      if (coverage === undefined) return
      for (const { path, error } of coverage.untestedFailures ?? []) {
        await fail(options.texts.untestedFailure(path, error.message, error.stack))
      }
      const reporting = await loadCoverageReporting()
      const map = reporting.createCoverageMap(coverage.map)
      try {
        await reporting.writeCoverageReports(map, {
          reporters: options.options.reporters,
          directory: options.options.directory,
          watermarks: options.options.watermarks,
          stdout: options.stdout,
          colour: options.consoleColour,
          ...(coverage.sources === undefined ? {} : { sources: coverage.sources }),
        })
        written = map
      } catch (error) {
        // `writeCoverageReports` wraps what a report threw; Jest prints that error.
        reportsMissed = true
        const cause = error instanceof Error && error.cause !== undefined ? error.cause : error
        const text = cause instanceof Error ? cause.toString() : String(cause)
        await fail(
          options.texts.reportFailure(text, cause instanceof Error ? cause.stack : undefined),
        )
      }
      // `_checkThreshold`: `FAIL_COLOR` (bold red) over the joined lines, to stderr.
      if (coverage.thresholdFailures.length > 0) {
        thresholdsMissed = true
        await options.stderr.write(
          `${options.style.bold(options.style.red(coverage.thresholdFailures.join('\n')))}\n`,
        )
      }
    },
  }
}

/**
 * Where a run that collects coverage reads and writes, and what it decides about the coverage.
 * @internal
 */
export interface CoverageRunOptions {
  /** The run's `RunCoverageOptions`, given the width of stdout when it is a terminal. */
  readonly options: (stdoutColumns: number | undefined) => RunCoverageOptions
  readonly texts: CoverageTexts
  readonly env: Environment
  readonly ci: boolean
  /** `--colors` or `--no-color`, when the command line says. */
  readonly colour?: boolean | undefined
  readonly stdout: TextSink
  readonly stderr: NodeJS.WritableStream
  /** What a relative threshold group resolves against. */
  readonly thresholdsCwd: string
  /** Whether a run that found no file still writes its (empty) reports. */
  readonly reportEmptyRun: boolean
}

/**
 * The reporter and the orchestrator's hooks of one run that collects coverage: the colour and
 * width of the terminal, the thresholds, and the notice written on a terminal while the files no
 * test loaded are covered (bold dim, cleared again on a TTY only). The caller builds the options.
 * @internal
 */
export function createCoverageRun(run: CoverageRunOptions): {
  readonly reporter: CoverageReporter
  readonly hooks: RunCoverageHooks
} {
  const { stdout, stderr } = run
  const columns: unknown = Reflect.get(stdout, 'columns')
  // The text reporters' own colour and terminal rules, read from stdout.
  const output = outputFor({
    env: run.env,
    stderr: stdout,
    ci: run.ci,
    colour: run.colour,
  })
  const style = styleOf(output)
  const options = run.options(typeof columns === 'number' && columns > 0 ? columns : undefined)
  const reporter = createCoverageReporter({
    options,
    stdout,
    stderr,
    consoleColour: output.colour,
    style,
    texts: run.texts,
  })
  const hooks: RunCoverageHooks = {
    thresholds: options.thresholds,
    thresholdsCwd: run.thresholdsCwd,
    reportEmptyRun: run.reportEmptyRun,
    ...(output.live
      ? {
          onUntested: {
            start: () => stderr.write(style.bold(style.dim(run.texts.untestedNotice))),
            end: () => {
              if (Reflect.get(stderr, 'isTTY') === true) stderr.write('\x1b[999D\x1b[K')
            },
          },
        }
      : {}),
  }
  return { reporter, hooks }
}
