import type { Reporter } from '@provino/types'
import { createTextReporter, type TextReporterOptions } from '../text/reporter.ts'

/**
 * The dot reporter: one character per test as it ends (`.` passed, `F` failed, `-` skipped or
 * todo), wrapped at the terminal's width (`columns`, 80 by default). At the end, the files that
 * failed with each failed test and its errors (as the agent reporter prints them), then the
 * totals. For a long run in a log nobody reads line by line.
 * @public
 */
export function dotReporter(options: TextReporterOptions): Reporter {
  return createTextReporter('dot', options)
}
