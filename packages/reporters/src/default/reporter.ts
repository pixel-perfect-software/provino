import type { Reporter } from '@provino/types'
import { createTextReporter, type DefaultReporterOptions } from '../text/reporter.ts'

export type { DefaultReporterOptions } from '../text/reporter.ts'

/**
 * The default reporter: Jest-like text. Per file, a `PASS` or `FAIL` line (none for a file whose
 * every test is skipped, as Jest prints none) with the file's console output under it and, for a
 * failure, each failed test's title with its errors; at the end `Test Suites:`, `Tests:` and
 * `Time:`. With `live`, the running files are a block at the bottom, redrawn in place; with
 * `colour`, the status words and counts are coloured. It keeps its tallies in the closure, so one
 * reporter serves one run at a time and starts over at each `run:start`.
 * @public
 */
export function defaultReporter(options: DefaultReporterOptions): Reporter {
  return createTextReporter('default', options)
}
