// Text a test wrote (console output, an error's message) goes into frames that move the cursor by
// line counts and cut by width. A cursor move, a screen clear or a bare carriage return in it would
// land on the footer, and the width cut would measure what the terminal does not draw. So it is
// cleaned first: every control character but newline and tab, and every escape sequence, is dropped.
// The one exception is SGR (colour and style: `ESC [ … m`), kept where the reporter draws colour
// itself, since Provino's own diffs use it; a line that carries any is closed with a reset, so a
// style a test left open cannot bleed into the next line. A test's own SGR is kept too (it cannot
// be told from Provino's), which is why the reset is there.

import { cleanText } from '../../internal/clean-text.ts'

/**
 * `text` with its control characters and escape sequences dropped (`\r\n` becomes `\n`, a lone `\r`
 * goes). With `keepSgr`, colour and style sequences stay and each line that has one ends in a reset.
 * The cleaner itself is shared with the HTML report (`internal/clean-text.ts`).
 * @beta
 */
export { cleanText }

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
