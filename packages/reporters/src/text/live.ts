// The live view: in a terminal, the files that are running are a block at the bottom of the output
// (`RUNS  path`, as Jest's status area), redrawn as files start and finish, and erased before any
// text is written above it. Without a terminal, in CI or under an agent nothing is redrawn: `print`
// writes its text and `start` and `finish` do nothing but write the text they are given.
import type { TextSink } from '../sink.ts'
import { ESC, type Style } from '../style.ts'

/** How many running files the block names; the rest are counted. */
const SHOWN = 4

/** The sequence that moves the cursor up `lines` lines to their start and erases to the end of the screen. */
function erase(lines: number): string {
  return lines === 0 ? '' : `${ESC}[${lines}F${ESC}[0J`
}

/** `text` cut to `width` columns, with an ellipsis. */
function fit(text: string, width: number): string {
  return text.length <= width ? text : `…${text.slice(text.length - Math.max(1, width - 1))}`
}

/**
 * Writes the reporter's text and, when `live`, keeps the running-files block below it.
 */
export interface LiveOutput {
  /** Writes `text` (with the newline), above the block when there is one. */
  print(text: string): Promise<void>
  /** A file started: `label` joins the block. */
  start(id: string, label: string): Promise<void>
  /**
   * A file ended: it leaves the block. `text` (written with its newline) goes above the block in
   * the same write that erases and redraws it, so the screen is drawn once for a file, not twice.
   */
  finish(id: string, text?: string): Promise<void>
  /** Erases the block for good, at the end of the run. */
  close(): Promise<void>
}

/**
 * Creates the output a text reporter writes through. `live` is whether the block is drawn at all;
 * `columns` is the terminal's width.
 */
export function createLiveOutput(
  stream: TextSink,
  options: { readonly live: boolean; readonly columns: number; readonly style: Style },
): LiveOutput {
  const { live, columns, style } = options
  /** Each running file's `RUNS …` line, rendered once, when it starts. */
  const running = new Map<string, string>()
  /** The block as last drawn, and how many lines it took. */
  let shown = ''
  let drawn = 0

  function block(): { readonly text: string; readonly lines: number } {
    let text = ''
    let lines = 0
    for (const line of running.values()) {
      if (lines === SHOWN) break
      text += `${line}\n`
      lines++
    }
    if (running.size > SHOWN) {
      text += `${style.dim(`  ... and ${running.size - SHOWN} more`)}\n`
      lines++
    }
    return { text, lines }
  }

  /** Erases the block, writes `text` and draws the block again; nothing when there is no text and the block is as it was. */
  async function redraw(text = ''): Promise<void> {
    const after = block()
    if (text === '' && after.text === shown) return
    const before = erase(drawn)
    shown = after.text
    drawn = after.lines
    await stream.write(`${before}${text}${after.text}`)
  }

  return {
    async print(text) {
      if (!live) {
        await stream.write(`${text}\n`)
        return
      }
      await redraw(`${text}\n`)
    },
    async start(id, label) {
      if (!live) return
      running.set(id, `${style.badge('RUNS', 'yellow')} ${fit(label, columns - 7)}`)
      await redraw()
    },
    async finish(id, text) {
      if (!live) {
        if (text !== undefined) await stream.write(`${text}\n`)
        return
      }
      running.delete(id)
      await redraw(text === undefined ? '' : `${text}\n`)
    },
    async close() {
      if (!live || drawn === 0) return
      running.clear()
      await redraw()
    },
  }
}
