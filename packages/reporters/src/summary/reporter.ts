import type { Reporter } from '@provino/types'
import { createTextReporter, type TextReporterOptions } from '../text/reporter.ts'

/**
 * Options for `summaryReporter`: the text reporters' own (`stream`, `report`, `colour`, `silent`,
 * `noStackTrace`), plus the ones only the summary reads (`failureText`, `failureSummaryThreshold`,
 * `snapshotSummary`, `closingLine`, `verboseRun`).
 * @public
 */
export type SummaryReporterOptions = TextReporterOptions

/**
 * The summary alone, as Jest's `SummaryReporter` prints it after the other reporters: a blank line
 * when the last file did not fail (none under `verboseRun`), the failures again when more suites
 * than `failureSummaryThreshold` (20) ran, the snapshot summary (the obsolete-snapshots block when
 * none is given), `Test Suites:`, `Tests:`, `Snapshots:` and `Time:`, then the closing line. A run
 * with no test files prints none of it. It prints nothing per file, so `default`, `verbose` or
 * `agent` with `summary: false` in front of it make up Jest's default output.
 * @public
 */
export function summaryReporter(options: SummaryReporterOptions): Reporter {
  return createTextReporter('summary', options)
}
