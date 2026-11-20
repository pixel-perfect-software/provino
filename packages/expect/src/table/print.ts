// How the table prints values and differences (D188, `speed`: Node's own `inspect` and `util.diff`,
// which Node 22.15 and later both have; `util.diff` is experimental, so the table's tests pin its
// entry shape: [0, line] is common, and in a change the first argument's line comes first).
// Neither pulls in a printer package.
import { inspect, diff as myers } from 'node:util'

/** A value on one line, as `util.inspect` shows it to a depth of 3 (what `formatValue` is). */
export const show = (value: unknown): string =>
  inspect(value, { depth: 3, breakLength: Infinity, compact: true })

const spread = (value: unknown): string[] =>
  (typeof value === 'string'
    ? value
    : inspect(value, { depth: 10, breakLength: 80, compact: 3, sorted: true })
  ).split('\n')

/** Above this many lines on either side the line diff is not computed (it takes seconds). */
export const MAX_DIFF_LINES = 2000
/** Unchanged lines kept around a change. */
const CONTEXT = 3

/**
 * The lines that differ between what was expected and what was received, as a block: `-` for a
 * line only the expected value has, `+` for one only the received value has, and the lines both have
 * with two spaces, a few around each change and `... n unchanged lines` for a longer common run.
 * `undefined` when the printed forms are equal. Past `MAX_DIFF_LINES` the block says it was not
 * computed.
 */
export function diffLines(expected: unknown, received: unknown): string | undefined {
  const expectedLines = spread(expected)
  const receivedLines = spread(received)
  const biggest = Math.max(expectedLines.length, receivedLines.length)
  if (biggest > MAX_DIFF_LINES) {
    return `The values are too large to diff: ${biggest} lines (the limit is ${MAX_DIFF_LINES}).`
  }
  const entries = myers(receivedLines, expectedLines)
  const changed = entries.map(([op]) => op !== 0)
  if (!changed.includes(true)) return undefined
  const lines: string[] = ['- Expected', '+ Received', '']
  let index = 0
  while (index < entries.length) {
    if (changed[index]) {
      const [op, line] = entries[index] ?? [0, '']
      lines.push(`${op === 1 ? '+' : '-'} ${line}`)
      index++
      continue
    }
    let end = index
    while (end < entries.length && !changed[end]) end++
    const before = index === 0 ? 0 : CONTEXT
    const after = end === entries.length ? 0 : CONTEXT
    const run = entries.slice(index, end)
    if (run.length <= before + after + 1) {
      for (const [, line] of run) lines.push(`  ${line}`)
    } else {
      for (const [, line] of run.slice(0, before)) lines.push(`  ${line}`)
      const skipped = run.length - before - after
      lines.push(`  ... ${skipped} unchanged line${skipped === 1 ? '' : 's'}`)
      for (const [, line] of run.slice(run.length - after)) lines.push(`  ${line}`)
    }
    index = end
  }
  return lines.join('\n')
}
