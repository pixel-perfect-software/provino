// The HTML report's data: a string table, the caps on what is kept, the text of a failure, and the
// one way the data is written into the page. Pure: no clock, no file.

import type { SerializedError } from '@provino/types'
import { CUT_NOTE, cleanText, MAX_ERROR_TEXT } from '../internal/clean-text.ts'
import { formatErrors } from '../text/format.ts'
import type { ReportData } from './page/model.ts'

/** The longest text one failure keeps, in characters. */
export const MAX_FAILURE_TEXT: number = MAX_ERROR_TEXT

/** The failures of each kind (failed tests, a file's own errors, errors outside the files) whose text a report keeps; the rest are counted (`ReportData.omitted`). */
export const MAX_FAILURES: number = 1000

/** The marker that ends a failure's text when it was cut. */
export const TRUNCATED: string = CUT_NOTE

/**
 * Every path, title and project name once: rows hold the ids.
 * @internal
 */
export interface StringTable {
  /** The id of `text`; a text seen before has the id it had. */
  intern(text: string): number
  /** The strings in id order. */
  readonly strings: string[]
}

/**
 * An empty string table. The reporter makes a new one for each run.
 * @internal
 */
export function createStringTable(): StringTable {
  const ids = new Map<string, number>()
  const strings: string[] = []
  return {
    strings,
    intern(text) {
      const known = ids.get(text)
      if (known !== undefined) return known
      const id = strings.length
      ids.set(text, id)
      strings.push(text)
      return id
    },
  }
}

/** Milliseconds to one decimal: a test's time needs no more, and a row is read for size. */
export function roundMs(ms: number): number {
  return Math.round(ms * 10) / 10
}

/** `text` cut to `MAX_FAILURE_TEXT` characters, without splitting a surrogate pair. */
function capped(text: string): string {
  if (text.length <= MAX_FAILURE_TEXT) return text
  let end = MAX_FAILURE_TEXT - TRUNCATED.length
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  return `${text.slice(0, end)}${TRUNCATED}`
}

/**
 * The text of a failure: the errors as the text reporters print them (message, the user's frames,
 * then the cause), with the run's root left out of every path, colours dropped, and at most
 * `MAX_FAILURE_TEXT` characters. `roots` is the root as the run named it and its real path (a
 * frame holds the real path of a symlinked root, as `/private/var/…` for `/var/…`).
 * @internal
 */
export function failureText(errors: readonly SerializedError[], roots: readonly string[]): string {
  let text = cleanText(formatErrors(errors), false)
  for (const root of roots) {
    for (const prefix of rootPrefixes(root)) text = text.replace(rootPattern(prefix), '$1')
  }
  return capped(text)
}

/** `prefix` where a path starts: not in the middle of another one (`other/project/`). */
function rootPattern(prefix: string): RegExp {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
  return new RegExp(String.raw`(^|[^\w.~/\\-])${escaped}`, 'g')
}

/** The forms of the root a path can start with: `/project/` and, on Windows, `C:\project\`. */
function rootPrefixes(root: string): readonly string[] {
  if (root === '' || root === '/') return []
  const trimmed = root.replace(/[\\/]+$/, '')
  return [`${trimmed}/`, `${trimmed}\\`, `file://${trimmed}/`]
}

/**
 * The data as the JSON text that goes inside the page's `<script type="application/json">`: `<`
 * (which would end the script with `</script>` or open a comment), U+2028 and U+2029 (line
 * terminators in older script grammars) written as `\u` escapes, which `JSON.parse` reads back as
 * the same characters.
 * @internal
 */
export function serializeData(data: ReportData): string {
  return JSON.stringify(data)
    .replaceAll('<', String.raw`\u003c`)
    .replaceAll('\u2028', String.raw`\u2028`)
    .replaceAll('\u2029', String.raw`\u2029`)
}
