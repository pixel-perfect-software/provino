// The escape sequences the live renderer writes: cursor visibility, synchronized updates (mode
// 2026, which terminals without it ignore), line erase and cursor moves, OSC 8 hyperlinks.

import { ESC } from '../../style.ts'

const CSI = `${ESC}[`

/** Hides the cursor. */
export const HIDE_CURSOR: string = `${CSI}?25l`
/** Shows the cursor. */
export const SHOW_CURSOR: string = `${CSI}?25h`
/** Begins a synchronized update: the terminal holds the screen until the matching end. */
export const BEGIN_SYNC: string = `${CSI}?2026h`
/** Ends a synchronized update. */
export const END_SYNC: string = `${CSI}?2026l`
/** Erases the whole line the cursor is on. */
export const ERASE_LINE: string = `${CSI}2K`
/** Erases from the cursor to the end of the screen. */
export const ERASE_DOWN: string = `${CSI}0J`
/** Resets every SGR attribute. */
export const RESET_STYLE: string = `${CSI}0m`

/** Moves the cursor up `lines` lines, to the start of that line. `lines` must be at least 1. */
export function cursorUp(lines: number): string {
  return `${CSI}${lines}F`
}

/** Moves the cursor down `lines` lines, to the start of that line. `lines` must be at least 1. */
export function cursorDown(lines: number): string {
  return `${CSI}${lines}E`
}

/** `text` as an OSC 8 hyperlink to `uri`. */
export function hyperlink(uri: string, text: string): string {
  return `${ESC}]8;;${uri}${ESC}\\${text}${ESC}]8;;${ESC}\\`
}

/**
 * One escape sequence at the start of a match: a CSI (`ESC [`, parameters, one final byte), an
 * OSC (`ESC ]` up to BEL or `ESC \`) or a two-character escape.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character is the point.
const ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/y

/**
 * The length of the escape sequence that starts at `index` of `text`, or 0 when none does.
 * @internal
 */
export function escapeLengthAt(text: string, index: number): number {
  if (text.charCodeAt(index) !== 27) return 0
  ESCAPE.lastIndex = index
  const match = ESCAPE.exec(text)
  return match === null ? 1 : match[0].length
}

/** `text` without its CSI and OSC sequences, which take no room on screen. */
export function stripControls(text: string): string {
  if (!text.includes(ESC)) return text
  let out = ''
  let start = 0
  for (let i = text.indexOf(ESC); i !== -1; i = text.indexOf(ESC, i)) {
    out += text.slice(start, i)
    i += escapeLengthAt(text, i)
    start = i
  }
  return out + text.slice(start)
}
