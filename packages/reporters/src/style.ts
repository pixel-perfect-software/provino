// ANSI styling for the text reporters: a handful of SGR codes, switched on or off as a whole. A
// reporter builds its `Style` once from the run's `colour` and calls it for every piece it wants
// styled; with colour off every function returns its text as it was given.

import type { TextStyle } from '@provino/types'

/**
 * The styles the reporters use (`TextStyle` in `@provino/types`, which a dialect's text builders take).
 * @public
 */
export type Style = TextStyle

/** The escape character that starts every SGR sequence and the cursor moves of the live block. */
export const ESC: string = String.fromCharCode(27)

function wrap(open: number, close: number): (text: string) => string {
  const start = `${ESC}[${open}m`
  const end = `${ESC}[${close}m`
  return (text) => (text === '' ? text : `${start}${text.replaceAll(end, `${end}${start}`)}${end}`)
}

const COLOURS = { green: 32, red: 31, yellow: 33 } as const

/**
 * Builds the styles: ANSI when `enabled`, plain text when not.
 * @public
 */
export function createStyle(enabled: boolean): Style {
  if (!enabled) {
    const same = (text: string): string => text
    return {
      bold: same,
      dim: same,
      red: same,
      green: same,
      yellow: same,
      magenta: same,
      badge: (word) => word,
    }
  }
  const bold = wrap(1, 22)
  const inverse = wrap(7, 27)
  const badge = (word: string, colour: keyof typeof COLOURS): string =>
    `${ESC}[0m${inverse(bold(wrap(COLOURS[colour], 39)(` ${word} `)))}${ESC}[0m`
  // The three the reporters write for every file are built once.
  const pass = badge('PASS', 'green')
  const fail = badge('FAIL', 'red')
  const runs = badge('RUNS', 'yellow')
  return {
    bold,
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    magenta: wrap(35, 39),
    badge: (word, colour) => {
      if (word === 'PASS' && colour === 'green') return pass
      if (word === 'FAIL' && colour === 'red') return fail
      if (word === 'RUNS' && colour === 'yellow') return runs
      return badge(word, colour)
    },
  }
}
