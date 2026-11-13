// ANSI styling for the text reporters: a handful of SGR codes, switched on or off as a whole. A
// reporter builds its `Style` once from the run's `colour` and calls it for every piece it wants
// styled; with colour off every function returns its text as it was given.

/**
 * The styles the reporters use. Each function wraps its text in an SGR sequence and its reset,
 * and puts the sequence back after any reset inside the text, so styles nest.
 * @public
 */
export interface Style {
  /** Whether the functions add anything. */
  readonly enabled: boolean
  bold(text: string): string
  dim(text: string): string
  red(text: string): string
  green(text: string): string
  yellow(text: string): string
  cyan(text: string): string
  magenta(text: string): string
  /**
   * A status word on a coloured block (inverse, bold): Jest's ` PASS ` and ` FAIL ` badges. With
   * colour off it is the bare word, as Jest prints it, so `PASS path` stays a line anyone can match.
   */
  badge(word: string, colour: 'green' | 'red' | 'yellow'): string
}

const ESC = String.fromCharCode(27)

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
      enabled,
      bold: same,
      dim: same,
      red: same,
      green: same,
      yellow: same,
      cyan: same,
      magenta: same,
      badge: (word) => word,
    }
  }
  const bold = wrap(1, 22)
  const inverse = wrap(7, 27)
  return {
    enabled,
    bold,
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
    magenta: wrap(35, 39),
    badge: (word, colour) =>
      `${ESC}[0m${inverse(bold(wrap(COLOURS[colour], 39)(` ${word} `)))}${ESC}[0m`,
  }
}
