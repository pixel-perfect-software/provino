import type { Reporter } from '@provino/types'
import { createTextReporter, type TextReporterOptions } from '../text/reporter.ts'

/**
 * The agent reporter, for a run an AI coding agent reads: only the files that failed (their
 * header, each failed test and its errors) and the totals, so a passing run is a few lines and a
 * failing one holds what is needed to fix it. No console output, no colour unless asked for, no
 * live block. Like Jest 30.5's: the default reporter, quiet about everything that passed.
 * @public
 */
export function agentReporter(options: TextReporterOptions): Reporter {
  return createTextReporter('agent', options)
}
