// tinyrainbow 3.2.0 (MIT, Copyright (c) 2022 Tinylibs), the version `@vitest/utils` and
// `@vitest/expect` 5.0.5 install. Ported to TypeScript from the published `dist/index.js` (the
// package has no `.refs` clone): the same colour test and the same open/close pairs, only the names
// spelled out. See UPSTREAM.md.

export interface Formatter {
  (input?: unknown): string
  open: string
  close: string
}

export interface Colors {
  isColorSupported: boolean
  reset: Formatter
  bold: Formatter
  dim: Formatter
  italic: Formatter
  underline: Formatter
  inverse: Formatter
  hidden: Formatter
  strikethrough: Formatter
  black: Formatter
  red: Formatter
  green: Formatter
  yellow: Formatter
  blue: Formatter
  magenta: Formatter
  cyan: Formatter
  white: Formatter
  gray: Formatter
  bgBlack: Formatter
  bgRed: Formatter
  bgGreen: Formatter
  bgYellow: Formatter
  bgBlue: Formatter
  bgMagenta: Formatter
  bgCyan: Formatter
  bgWhite: Formatter
  blackBright: Formatter
  redBright: Formatter
  greenBright: Formatter
  yellowBright: Formatter
  blueBright: Formatter
  magentaBright: Formatter
  cyanBright: Formatter
  whiteBright: Formatter
  bgBlackBright: Formatter
  bgRedBright: Formatter
  bgGreenBright: Formatter
  bgYellowBright: Formatter
  bgBlueBright: Formatter
  bgMagentaBright: Formatter
  bgCyanBright: Formatter
  bgWhiteBright: Formatter
}

const plain: Formatter = Object.assign((input?: unknown) => String(input), { open: '', close: '' })
const none = (_open: string, _close: string, _replace?: string): Formatter => plain
const FG_CLOSE = '\x1B[39m'
const BG_CLOSE = '\x1B[49m'

function replaceClose(text: string, close: string, replace: string, index: number, length: number): string {
  let result = ''
  let cursor = 0
  do {
    result += text.substring(cursor, index) + replace
    cursor = index + length
    index = text.indexOf(close, cursor)
  } while (~index)
  return result + text.substring(cursor)
}

function formatter(open: string, close: string, replace = open, at = open.length): Formatter {
  const closeLength = close.length
  const format = (input?: unknown): string => {
    const text = `${input}`
    const index = text.indexOf(close, at)
    return ~index
      ? open + replaceClose(text, close, replace, index, closeLength) + close
      : open + text + close
  }
  return Object.assign(format, { open, close })
}

function createColorsFrom(supported: boolean): Colors {
  const f = supported ? formatter : none
  return {
    isColorSupported: supported,
    reset: f('\x1B[0m', '\x1B[0m'),
    bold: f('\x1B[1m', '\x1B[22m', '\x1B[22m\x1B[1m'),
    dim: f('\x1B[2m', '\x1B[22m', '\x1B[22m\x1B[2m'),
    italic: f('\x1B[3m', '\x1B[23m'),
    underline: f('\x1B[4m', '\x1B[24m'),
    inverse: f('\x1B[7m', '\x1B[27m'),
    hidden: f('\x1B[8m', '\x1B[28m'),
    strikethrough: f('\x1B[9m', '\x1B[29m'),
    black: f('\x1B[30m', FG_CLOSE),
    red: f('\x1B[31m', FG_CLOSE),
    green: f('\x1B[32m', FG_CLOSE),
    yellow: f('\x1B[33m', FG_CLOSE),
    blue: f('\x1B[34m', FG_CLOSE),
    magenta: f('\x1B[35m', FG_CLOSE),
    cyan: f('\x1B[36m', FG_CLOSE),
    white: f('\x1B[37m', FG_CLOSE),
    gray: f('\x1B[90m', FG_CLOSE),
    bgBlack: f('\x1B[40m', BG_CLOSE),
    bgRed: f('\x1B[41m', BG_CLOSE),
    bgGreen: f('\x1B[42m', BG_CLOSE),
    bgYellow: f('\x1B[43m', BG_CLOSE),
    bgBlue: f('\x1B[44m', BG_CLOSE),
    bgMagenta: f('\x1B[45m', BG_CLOSE),
    bgCyan: f('\x1B[46m', BG_CLOSE),
    bgWhite: f('\x1B[47m', BG_CLOSE),
    blackBright: f('\x1B[90m', FG_CLOSE),
    redBright: f('\x1B[91m', FG_CLOSE),
    greenBright: f('\x1B[92m', FG_CLOSE),
    yellowBright: f('\x1B[93m', FG_CLOSE),
    blueBright: f('\x1B[94m', FG_CLOSE),
    magentaBright: f('\x1B[95m', FG_CLOSE),
    cyanBright: f('\x1B[96m', FG_CLOSE),
    whiteBright: f('\x1B[97m', FG_CLOSE),
    bgBlackBright: f('\x1B[100m', BG_CLOSE),
    bgRedBright: f('\x1B[101m', BG_CLOSE),
    bgGreenBright: f('\x1B[102m', BG_CLOSE),
    bgYellowBright: f('\x1B[103m', BG_CLOSE),
    bgBlueBright: f('\x1B[104m', BG_CLOSE),
    bgMagentaBright: f('\x1B[105m', BG_CLOSE),
    bgCyanBright: f('\x1B[106m', BG_CLOSE),
    bgWhiteBright: f('\x1B[107m', BG_CLOSE),
  }
}

/** tinyrainbow's `isSupported`. */
export function isSupported(): boolean {
  const proc = typeof process !== 'undefined' ? process : undefined
  const env: Record<string, string | undefined> = proc?.env ?? {}
  const tty = env.FORCE_TTY !== 'false'
  const argv = proc?.argv ?? []
  return (
    (!('NO_COLOR' in env || argv.includes('--no-color')) &&
      ('FORCE_COLOR' in env ||
        argv.includes('--color') ||
        proc?.platform === 'win32' ||
        (tty && env.TERM !== 'dumb') ||
        'CI' in env)) ||
    (typeof (globalThis as { window?: { chrome?: unknown } }).window !== 'undefined' &&
      !!(globalThis as { window?: { chrome?: unknown } }).window?.chrome)
  )
}

export function createColors({ force }: { force?: boolean } = {}): Colors {
  return createColorsFrom(force || isSupported())
}

export function getDefaultColors(): Colors {
  return createColorsFrom(false)
}

const defaultColors: Colors = createColors()

export default defaultColors
