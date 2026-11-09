// `core.formatValue` for Jest (T5.7): how jest-circus 30.5 prints a value in the messages it builds,
// `prettyFormat(value, { maxDepth: 3 })` (`utils.ts` L231-L253, L290-L300: `Failed: <reason>`,
// `Returned value: <value>`).
import type { FormatValue } from '@provino/types'
import { format } from 'pretty-format'

/**
 * Prints a value as jest-circus prints it in a message: pretty-format, three levels deep.
 * @public
 */
export const formatValue: FormatValue = (value) => format(value, { maxDepth: 3 })
