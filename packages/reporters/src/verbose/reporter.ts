import type { Reporter } from '@provino/types'
import { createTextReporter, type TextReporterOptions } from '../text/reporter.ts'

/**
 * The verbose reporter: the default reporter's text with each file's tests listed under its
 * header, grouped by their `describe` titles with a mark for each (a check, a cross, a circle for
 * a skipped test, a pencil for a todo one), as Jest's `--verbose` lists them. A file's console
 * output comes before its header, as Jest prints it while the tests run. `expand` lists skipped and
 * todo tests in declaration order instead of after the others.
 * @public
 */
export function verboseReporter(options: TextReporterOptions): Reporter {
  return createTextReporter('verbose', options)
}
