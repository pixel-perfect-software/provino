// The coverage reporter of a run that collects coverage (B23b, T8.10): at `run:end` it writes the
// reports from `RunSummary.coverage`, as Jest's CoverageReporter does in `onRunComplete`. It sits
// where Jest's sits: after the reporters the config names and before the summary. The threshold
// failures (`CoverageSummary.thresholdFailures`, T8.11) are printed last, after the reports, and
// make the run fail (the orchestrator's exit code reads them; Jest's reporter keeps them as its
// error).
import { loadCoverageReporting } from '@provino/coverage/node'
import type { TextSink } from '@provino/reporters'
import type { Reporter, RunCoverageOptions, RunSummary, TextStyle } from '@provino/types'

/**
 * What a dialect prints around the reports (Jest's are `jestCoverageTexts`).
 * @internal
 */
export interface CoverageTexts {
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
}

/**
 * Creates the coverage reporter of one run.
 * @internal
 */
export function createCoverageReporter(options: CoverageReporterOptions): CoverageReporter {
  let written: unknown
  let thresholdsMissed = false
  const fail = (text: string): unknown => options.stderr.write(`${options.style.red(text)}\n`)
  return {
    name: 'coverage',
    coverageMap: () => written,
    thresholdsFailed: () => thresholdsMissed,
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
