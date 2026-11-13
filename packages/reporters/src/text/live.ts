// The live view: in a terminal, the files that are running are a block at the bottom of the output
// (`RUNS  path`, as Jest's status area), redrawn as files start and finish, and erased before any
// text is written above it. Without a terminal, in CI or under an agent nothing is redrawn: `print`
// writes its text and `start` and `finish` do nothing.
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
  /** A file ended: it leaves the block. */
  finish(id: string): Promise<void>
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
  const running = new Map<string, string>()
  /** How many lines the block took the last time it was drawn. */
  let drawn = 0

  function block(): string {
    const labels = [...running.values()]
    const lines = labels
      .slice(0, SHOWN)
      .map((label) => `${style.badge('RUNS', 'yellow')} ${fit(label, columns - 7)}`)
    if (labels.length > SHOWN) lines.push(style.dim(`  ... and ${labels.length - SHOWN} more`))
    drawn = lines.length
    return lines.map((line) => `${line}\n`).join('')
  }

  async function redraw(text = ''): Promise<void> {
    const before = erase(drawn)
    const after = block()
    await stream.write(`${before}${text}${after}`)
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
      running.set(id, label)
      await redraw()
    },
    async finish(id) {
      if (!live) return
      running.delete(id)
      await redraw()
    },
    async close() {
      if (!live || drawn === 0) return
      running.clear()
      await redraw()
    },
  }
}
