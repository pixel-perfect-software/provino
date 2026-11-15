// A watch session's terminal as text (B23c Phase 3). Jest's watch mode draws on the terminal: the
// default reporter's live `RUNS` block is printed and erased again on a timer, the pattern prompt
// moves the cursor and redraws its line, and every run starts with a clear. A golden can't hold
// the bytes (the redraws depend on timing), so the bytes are played on a small model of a terminal
// with unlimited scrollback, and the transcript is the rows the session left: a status block that
// was erased leaves nothing, a prompt line keeps what it last showed, and each screen clear is a
// `<CLEAR>` row.
import { PTY_COLUMNS, PTY_ROWS } from '../pty.ts'

/** The row a screen clear (`ESC [ 2 J`) leaves in the transcript. */
export const CLEAR_ROW = '<CLEAR>'

interface Cursor {
  row: number
  col: number
}

/**
 * The model: rows of text, the cursor, and the screen's top row (where `ESC [ r ; c H` counts
 * from), which a clear moves to a fresh row and output past the screen's height scrolls.
 */
class Terminal {
  readonly rows: string[] = ['']
  readonly cursor: Cursor = { row: 0, col: 0 }
  #top = 0
  #saved: Cursor = { row: 0, col: 0 }

  readonly height: number
  readonly width: number

  constructor(height: number, width: number) {
    this.height = height
    this.width = width
  }

  #line(row: number): string {
    while (this.rows.length <= row) this.rows.push('')
    return this.rows[row] ?? ''
  }

  #set(row: number, text: string): void {
    this.#line(row)
    this.rows[row] = text
  }

  #scroll(): void {
    if (this.cursor.row > this.#top + this.height - 1) this.#top = this.cursor.row - this.height + 1
  }

  put(char: string): void {
    if (this.cursor.col >= this.width) this.newline()
    // A row is code points, one to a column (Jest's marks, `›` `✓` `✕`, are one column wide).
    const cells = [...this.#line(this.cursor.row)]
    while (cells.length < this.cursor.col) cells.push(' ')
    cells[this.cursor.col] = char
    this.#set(this.cursor.row, cells.join(''))
    this.cursor.col += 1
  }

  newline(): void {
    this.cursor.row += 1
    this.cursor.col = 0
    this.#line(this.cursor.row)
    this.#scroll()
  }

  carriageReturn(): void {
    this.cursor.col = 0
  }

  backspace(): void {
    this.cursor.col = Math.max(0, this.cursor.col - 1)
  }

  tab(): void {
    this.cursor.col = Math.min(this.width - 1, (Math.floor(this.cursor.col / 8) + 1) * 8)
  }

  /**
   * Up `n` rows. A row the cursor leaves that is blank and the last one is dropped: Jest erases its
   * status block line by line going up (`\r ESC[K \r ESC[1A`), and the block leaves no rows.
   */
  up(n: number): void {
    for (let i = 0; i < n && this.cursor.row > this.#top; i += 1) {
      const last = this.rows.length - 1
      if (this.cursor.row === last && this.#line(last).trim() === '') this.rows.pop()
      this.cursor.row -= 1
    }
  }

  down(n: number): void {
    this.cursor.row += n
    this.#line(this.cursor.row)
    this.#scroll()
  }

  forward(n: number): void {
    this.cursor.col = Math.min(this.width - 1, this.cursor.col + n)
  }

  back(n: number): void {
    this.cursor.col = Math.max(0, this.cursor.col - n)
  }

  column(n: number): void {
    this.cursor.col = Math.min(this.width - 1, Math.max(0, n - 1))
  }

  moveTo(row: number, col: number): void {
    this.cursor.row = this.#top + Math.min(this.height - 1, Math.max(0, row - 1))
    this.cursor.col = Math.min(this.width - 1, Math.max(0, col - 1))
    this.#line(this.cursor.row)
  }

  /** `ESC [ n K`: 0 from the cursor to the end, 1 from the start to the cursor, 2 the whole row. */
  eraseInLine(mode: number): void {
    const cells = [...this.#line(this.cursor.row)]
    if (mode === 2) this.#set(this.cursor.row, '')
    else if (mode === 1) {
      const kept = cells.slice(this.cursor.col + 1).join('')
      this.#set(this.cursor.row, ' '.repeat(this.cursor.col + 1) + kept)
    } else this.#set(this.cursor.row, cells.slice(0, this.cursor.col).join(''))
  }

  /** `ESC [ n J`: 0 from the cursor down (the rows below are dropped), 1 the screen above it. */
  eraseInDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      if (mode === 2) this.clear()
      return
    }
    if (mode === 1) {
      for (let row = this.#top; row < this.cursor.row; row += 1) this.#set(row, '')
      this.eraseInLine(1)
      return
    }
    this.eraseInLine(0)
    this.rows.length = this.cursor.row + 1
  }

  /** A clear of the screen: a `<CLEAR>` row after what is there, and a fresh screen below it. */
  clear(): void {
    while (this.rows.length > 1 && (this.rows.at(-1) ?? '').trim() === '') this.rows.pop()
    if (this.rows.length === 1 && (this.rows[0] ?? '') === '') this.rows[0] = CLEAR_ROW
    else this.rows.push(CLEAR_ROW)
    this.rows.push('')
    this.#top = this.rows.length - 1
    this.cursor.row = this.#top
    this.cursor.col = 0
  }

  save(): void {
    this.#saved = { ...this.cursor }
  }

  restore(): void {
    this.cursor.row = this.#saved.row
    this.cursor.col = this.#saved.col
    this.#line(this.cursor.row)
  }
}

/** `ESC [` parameters, the final byte, and whether the sequence is a private one (`ESC [ ?`). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the sequence being parsed.
const CSI = /^\u001b\[([?>=]?)([0-9;]*)([ -/]*)([@-~])/
/** OSC (`ESC ]` ... BEL or `ESC \`): a title, a hyperlink. Never shown. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC and BEL are the sequence being parsed.
const OSC = /^\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/

function params(raw: string, fallback: number): number[] {
  if (raw === '') return [fallback]
  return raw.split(';').map((part) => (part === '' ? fallback : Number.parseInt(part, 10)))
}

function applyCsi(terminal: Terminal, privateMark: string, raw: string, final: string): void {
  // Private modes (`ESC[?25l` hides the cursor, `ESC[?2026h` starts a synchronized update) and
  // colours (`m`) change nothing a transcript shows.
  if (privateMark !== '' || final === 'm') return
  const [first = 1, second = 1] = params(raw, 1)
  switch (final) {
    case 'A':
      terminal.up(first)
      break
    case 'B':
      terminal.down(first)
      break
    case 'C':
      terminal.forward(first)
      break
    case 'D':
      terminal.back(first)
      break
    case 'E':
      terminal.down(first)
      terminal.carriageReturn()
      break
    case 'F':
      terminal.up(first)
      terminal.carriageReturn()
      break
    case 'G':
      terminal.column(first)
      break
    case 'H':
    case 'f':
      terminal.moveTo(first, second)
      break
    case 'K':
      terminal.eraseInLine(params(raw, 0)[0] ?? 0)
      break
    case 'J':
      terminal.eraseInDisplay(params(raw, 0)[0] ?? 0)
      break
    case 's':
      terminal.save()
      break
    case 'u':
      terminal.restore()
      break
    default:
      // Scroll regions, insert and delete: Jest's watch mode writes none of them.
      break
  }
}

/**
 * Plays a terminal's output on the model and returns the rows it left, each without trailing
 * spaces, with no blank rows at the end. `\r\n` (a terminal's newline) and `\n` both end a row.
 */
export function renderTranscript(
  output: string,
  size: { readonly rows: number; readonly columns: number } = {
    rows: PTY_ROWS,
    columns: PTY_COLUMNS,
  },
): string {
  const terminal = new Terminal(size.rows, size.columns)
  let index = 0
  while (index < output.length) {
    const char = String.fromCodePoint(output.codePointAt(index) ?? 0)
    if (char === '\u001b') {
      const rest = output.slice(index, index + 64)
      const csi = CSI.exec(rest)
      if (csi !== null) {
        applyCsi(terminal, csi[1] ?? '', csi[2] ?? '', csi[4] ?? '')
        index += csi[0].length
        continue
      }
      const osc = OSC.exec(output.slice(index))
      if (osc !== null) {
        index += osc[0].length
        continue
      }
      const next = output[index + 1]
      // `ESC 7` and `ESC 8` save and restore the cursor (ansi-escapes on Apple's Terminal).
      if (next === '7') terminal.save()
      else if (next === '8') terminal.restore()
      index += next === undefined ? 1 : 2
      continue
    }
    if (char === '\n') terminal.newline()
    else if (char === '\r') terminal.carriageReturn()
    else if (char === '\b') terminal.backspace()
    else if (char === '\t') terminal.tab()
    else if (char >= ' ' && char !== '\u007f') terminal.put(char)
    // Any other control character (a bell) shows nothing.
    index += char.length
  }
  const rows = terminal.rows.map((row) => row.trimEnd())
  while (rows.length > 0 && rows.at(-1) === '') rows.pop()
  return rows.join('\n')
}

/**
 * The times a run prints (`Time: 1.234 s`, `estimated 2 s`, `(5 ms)`) as `<time>`: no two runs
 * share them.
 */
export function maskTimes(text: string): string {
  return text.replace(/\b\d+(?:\.\d+)?\s?m?s\b/g, '<time>')
}
