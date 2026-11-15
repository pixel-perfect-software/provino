// The terminal sequences Jest 30.5.2's watch mode writes, as constants, so the dialect needs no
// `ansi-escapes` (4.3.2, the version jest-core and jest-watcher depend on) or `string-length`.
// Colour is the host's (`TextStyle`), never written here.

const CSI = '\u001B['

/**
 * jest-util `specialChars.CLEAR` (`specialChars.ts` L11-L13): erase the screen and the scrollback,
 * cursor home; on Windows erase the screen and home.
 * @beta
 */
export function jestClearScreen(platform: NodeJS.Platform): string {
  return platform === 'win32' ? '\u001B[2J\u001B[0f' : '\u001B[2J\u001B[3J\u001B[H'
}

/**
 * The escapes of `ansi-escapes` 4.3.2 the watch mode uses (`index.js` L46-L77). The cursor's save and
 * restore are `ESC 7` and `ESC 8` under Apple's Terminal (`TERM_PROGRAM === 'Apple_Terminal'`),
 * else `CSI s` and `CSI u`.
 * @beta
 */
export interface JestTerminalEscapes {
  readonly cursorHide: string
  readonly cursorShow: string
  readonly cursorLeft: string
  readonly eraseLine: string
  readonly eraseDown: string
  readonly cursorSavePosition: string
  readonly cursorRestorePosition: string
  cursorUp(count?: number): string
  cursorDown(count?: number): string
  cursorTo(x: number, y: number): string
}

/**
 * The escapes for a terminal (`appleTerminal`: `TERM_PROGRAM` is `Apple_Terminal`).
 * @beta
 */
export function jestTerminalEscapes(appleTerminal: boolean): JestTerminalEscapes {
  return {
    cursorHide: `${CSI}?25l`,
    cursorShow: `${CSI}?25h`,
    cursorLeft: `${CSI}G`,
    eraseLine: `${CSI}2K`,
    eraseDown: `${CSI}J`,
    cursorSavePosition: appleTerminal ? '\u001B7' : `${CSI}s`,
    cursorRestorePosition: appleTerminal ? '\u001B8' : `${CSI}u`,
    cursorUp: (count = 1) => `${CSI}${count}A`,
    cursorDown: (count = 1) => `${CSI}${count}B`,
    cursorTo: (x, y) => `${CSI}${y + 1};${x + 1}H`,
  }
}

/**
 * jest-util `clearLine` (`clearLine.ts` L10-L14): what a reporter writes to a terminal before its
 * first line, and what `CustomConsole` writes before each entry, so the pre-run message goes.
 * @beta
 */
export const JEST_CLEAR_LINE: string = `${CSI}999D${CSI}K`

/**
 * jest-util `preRunMessage.print` (`preRunMessage.ts` L13-L17): written before each run on an
 * interactive terminal, bold and dim.
 * @beta
 */
export const JEST_PRE_RUN_MESSAGE: string = 'Determining test suites to run...'

// Every CSI sequence (`ESC [`, parameters, one final byte) and the two-byte `ESC 7` and `ESC 8`.
const ESCAPES = new RegExp(`${String.fromCharCode(0x1b)}(?:\\[[0-?]*[ -/]*[@-~]|[78])`, 'g')

/**
 * `string-length` 4 as jest-watcher uses it (`patternModeHelpers.ts` L30): the length of the text
 * with its escapes taken out, in code points.
 * @beta
 */
export function jestStringLength(text: string): number {
  return [...text.replace(ESCAPES, '')].length
}
