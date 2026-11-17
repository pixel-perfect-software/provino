// How many columns a string takes on a terminal, and cutting it to fit. ASCII, which is nearly
// every string the renderer measures, takes a 7-bit test and `length`. Anything else is split into
// grapheme clusters, and a cluster takes 0 columns (controls, combining marks, joiners), 2 (East
// Asian Wide or Fullwidth, an emoji drawn as emoji, any base followed by VS16) or 1 (everything
// else; ambiguous-width characters count as 1).

import { escapeLengthAt, stripControls } from './ansi.ts'
import { WIDE_RANGES } from './vendor/width-table.ts'

const PRINTABLE_ASCII = /^[ -~]*$/
/** A cluster that starts with a mark or a format character (a joiner, a zero-width space): no room. */
const ZERO_WIDTH_START = /^[\p{Mn}\p{Me}\p{Cf}]/u

const VS16 = 0xfe0f
const VS15 = 0xfe0e

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Whether `codePoint` is in the table of two-column ranges (binary search). */
function isWide(codePoint: number): boolean {
  let low = 0
  let high = WIDE_RANGES.length / 2 - 1
  while (low <= high) {
    const mid = (low + high) >>> 1
    const start = WIDE_RANGES[mid * 2] as number
    if (codePoint < start) high = mid - 1
    else if (codePoint > (WIDE_RANGES[mid * 2 + 1] as number)) low = mid + 1
    else return true
  }
  return false
}

/** The columns one grapheme cluster takes. */
function clusterWidth(cluster: string): number {
  const first = cluster.codePointAt(0) as number
  if (first < 0x20 || (first >= 0x7f && first < 0xa0)) return 0
  if (cluster.length > 1) {
    // A variation selector in the cluster decides: VS16 asks for emoji presentation (two
    // columns), VS15 for text (one).
    for (let i = 1; i < cluster.length; i++) {
      const unit = cluster.charCodeAt(i)
      if (unit === VS16) return 2
      if (unit === VS15) return 1
    }
  }
  if (first < 0x300) return 1
  if (ZERO_WIDTH_START.test(cluster)) return 0
  return isWide(first) ? 2 : 1
}

/** The width of `text` that has no escape sequences. */
function plainWidth(text: string): number {
  if (PRINTABLE_ASCII.test(text)) return text.length
  let width = 0
  for (const { segment } of segmenter.segment(text)) width += clusterWidth(segment)
  return width
}

/** How many terminal columns `text` takes. Escape sequences (SGR, OSC 8) take none. */
export function displayWidth(text: string): number {
  if (PRINTABLE_ASCII.test(text)) return text.length
  return plainWidth(stripControls(text))
}

/**
 * `text` cut to at most `columns` columns, ending in `…` when something was cut. It never cuts
 * inside an escape sequence or a grapheme cluster, and the escape sequences after the cut are kept
 * (they take no room), so styles and hyperlinks that were opened are closed.
 */
export function fitWidth(text: string, columns: number): string {
  if (columns <= 0) return ''
  if (PRINTABLE_ASCII.test(text)) {
    return text.length <= columns ? text : `${text.slice(0, columns - 1)}…`
  }
  if (displayWidth(text) <= columns) return text
  const budget = columns - 1
  let out = ''
  let used = 0
  let cut = false
  let index = 0
  while (index < text.length) {
    const sequence = escapeLengthAt(text, index)
    if (sequence > 0) {
      out += text.slice(index, index + sequence)
      index += sequence
      continue
    }
    // The run of text up to the next escape sequence, one cluster at a time.
    const next = text.indexOf('\u001b', index)
    const end = next === -1 ? text.length : next
    for (const { segment } of segmenter.segment(text.slice(index, end))) {
      if (!cut) {
        const width = clusterWidth(segment)
        if (used + width <= budget) {
          out += segment
          used += width
          continue
        }
        cut = true
        out += '…'
      }
    }
    index = end
  }
  return out
}

/**
 * `text` (no escape sequences) cut to at most `columns` columns from the left, with `…` first
 * when something was cut: `…/use-cart.test.tsx`. It never cuts inside a grapheme cluster.
 */
export function fitWidthLeft(text: string, columns: number): string {
  if (columns <= 0) return ''
  if (PRINTABLE_ASCII.test(text)) {
    return text.length <= columns ? text : `…${text.slice(text.length - (columns - 1))}`
  }
  if (plainWidth(text) <= columns) return text
  const clusters = [...segmenter.segment(text)]
  let used = 0
  let from = clusters.length
  while (from > 0) {
    const width = clusterWidth((clusters[from - 1] as { segment: string }).segment)
    if (used + width > columns - 1) break
    used += width
    from--
  }
  return `…${clusters
    .slice(from)
    .map((cluster) => cluster.segment)
    .join('')}`
}
