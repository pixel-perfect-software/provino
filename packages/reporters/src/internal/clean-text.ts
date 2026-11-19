// Text from a test (an error's message, its console output) is cleaned before it goes into a view
// that moves the cursor by line counts or is written into a page. The terminal's frames and the
// HTML report both clean it here, and cap an error's text at the same size.

import { ESC } from '../style.ts'

// The patterns are assembled from named parts so no control character is typed in a literal.
/** C0 but tab and newline, DEL and C1. */
const CONTROLS = String.raw`\u0000-\u0008\u000b-\u001f\u007f-\u009f`
const ESCAPE = String.raw`\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])`
/** A control character the cleaner may drop, or the start of an escape. */
const SUSPECT = new RegExp(`[${CONTROLS}]`)
/** One escape sequence (CSI, OSC, two-character), or one stray control character. */
const DROP = new RegExp(`${ESCAPE}|[${CONTROLS}]`, 'g')
const SGR_SOURCE = String.raw`^\u001b\[[0-9;]*m$`
const SGR = new RegExp(SGR_SOURCE)
const RESET = `${ESC}[0m`

/** The longest error text a view keeps, in characters. */
export const MAX_ERROR_TEXT: number = 16 * 1024

/** The note that ends an error's text when it was cut at `MAX_ERROR_TEXT`. */
export const CUT_NOTE = '\n… (cut at 16 KB)'

/**
 * `text` with its control characters and escape sequences dropped (`\r\n` becomes `\n`, a lone `\r`
 * goes). With `keepSgr`, colour and style sequences stay and each line that has one ends in a reset.
 * @internal
 */
export function cleanText(text: string, keepSgr: boolean): string {
  if (!SUSPECT.test(text)) return text
  const cleaned = text
    .replaceAll('\r\n', '\n')
    .replace(DROP, (match) => (keepSgr && SGR.test(match) ? match : ''))
  if (!keepSgr || !cleaned.includes(ESC)) return cleaned
  return cleaned
    .split('\n')
    .map((line) => (line.includes(ESC) ? `${line}${RESET}` : line))
    .join('\n')
}
