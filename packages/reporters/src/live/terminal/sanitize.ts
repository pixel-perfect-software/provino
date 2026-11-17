// Text a test wrote (console output, an error's message) goes into frames that move the cursor by
// line counts and cut by width. A cursor move, a screen clear or a bare carriage return in it would
// land on the footer, and the width cut would measure what the terminal does not draw. So it is
// cleaned first: every control character but newline and tab, and every escape sequence, is dropped.
// The one exception is SGR (colour and style: `ESC [ … m`), kept where the reporter draws colour
// itself, since Provino's own diffs use it; a line that carries any is closed with a reset, so a
// style a test left open cannot bleed into the next line. A test's own SGR is kept too (it cannot
// be told from Provino's), which is why the reset is there.

import { ESC } from '../../style.ts'

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

/**
 * `text` with its control characters and escape sequences dropped (`\r\n` becomes `\n`, a lone `\r`
 * goes). With `keepSgr`, colour and style sequences stay and each line that has one ends in a reset.
 * @beta
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

/** A newline or a tab, which `cleanText` leaves in: the whitespace that would break a one-line row. */
const LINE_BREAKS = /[\n\t]+/g

/**
 * `text` as one line with no control characters: `cleanText` without colour, then each run of
 * newlines and tabs one space. For a name or a message that goes in a row of a view.
 * @beta
 */
export function oneLine(text: string): string {
  return cleanText(text, false).replace(LINE_BREAKS, ' ')
}
