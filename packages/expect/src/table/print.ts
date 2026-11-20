// How the table prints values and differences (D188, `speed`: Node's own `inspect` and `util.diff`,
// which Node 22.15 and later both have; `util.diff` is experimental, so the table's tests pin its
// entry shape: [0, line] is common, and in a change the first argument's line comes first). Neither pulls in a printer package.
import { inspect, diff as myers } from 'node:util'

/** A value on one line, as `util.inspect` shows it to a depth of 3 (what `formatValue` is). */
export const show = (value: unknown): string =>
  inspect(value, { depth: 3, breakLength: Infinity, compact: true })

const spread = (value: unknown): readonly string[] =>
  (typeof value === 'string'
    ? value
    : inspect(value, { depth: 10, breakLength: 80, compact: 3, sorted: true })
  ).split('\n')

/**
 * The lines that differ between what was expected and what was received, as a block: `-` for a
 * line only the expected value has, `+` for one only the received value has, and the lines both have
 * with two spaces. `undefined` when the printed forms are equal.
 */
export function diffLines(expected: unknown, received: unknown): string | undefined {
  const entries = myers(spread(received) as string[], spread(expected) as string[])
  if (entries.length === 0 || entries.every(([op]) => op === 0)) return undefined
  const lines = entries.map(([op, line]) => `${op === 1 ? '+' : op === -1 ? '-' : ' '} ${line}`)
  return ['- Expected', '+ Received', '', ...lines].join('\n')
}
