import type { DefineReporter } from '@provino/types'

/**
 * Defines a reporter, keeping its name as a literal type and checking its handlers' names and
 * arguments against the bus's events. A reporter is a plain object; this is only the type check.
 * @public
 */
export const defineReporter: DefineReporter = (reporter) => reporter
