// ANSI styling for the text reporters: a handful of SGR codes, switched on or off as a whole. A
// reporter builds its `Style` once from the run's `colour` and calls it for every piece it wants
// styled; with colour off every function returns its text as it was given.

/**
 * The styles the reporters use. Each function wraps its text in an SGR sequence and its reset,
 * and puts the sequence back after any reset inside the text, so styles nest.
 * @public
 */
export interface Style {
  bold(text: string): string
  dim(text: string): string
  red(text: string): string
  green(text: string): string
  yellow(text: string): string
  magenta(text: string): string
  /**
   * A status word on a coloured block (inverse, bold): Jest's ` PASS ` and ` FAIL ` badges. With
   * colour off it is the bare word, as Jest prints it, so `PASS path` stays a line anyone can match.
   */
  badge(word: string, colour: 'green' | 'red' | 'yellow'): string
}

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
