// The dot reporter's row of characters: one per test as it ends (`.` passed, `F` failed, `-`
// skipped or todo), wrapped at the terminal's width, with the text that belongs under the dots
// (the failed files, an `error` event, the totals) held back or moved down to start a line of its
// own. A sibling of `live.ts`: that one redraws a block in place, this one only appends.
import type { TaskState } from '@provino/types'
import type { TextSink } from '../sink.ts'
import type { Style } from '../style.ts'

/** The row of dots a text reporter writes in `dot` mode. */
export interface Dots {
  /** Writes the mark for a test that ended in `state`, wrapping at the width. */
  mark(state: TaskState): Promise<void>
  /**
   * Before text goes under the dots: ends their row so the text doesn't land in the middle of it.
   * Returns what that text starts with to leave a blank line under the dots: `'\n'`, or `''` when
   * the dots are not the last thing written.
   */
  leave(): Promise<string>
  /** Keeps a failed file's text, to print after the dots. */
  defer(text: string): void
  /** The deferred texts as they print, a line apart; `''` when none. */
  deferred(): string
  /** Starts over, at `run:start`. */
  reset(): void
}

/** The dots for a stream `columns` wide. */
export function createDots(stream: TextSink, columns: number, style: Style): Dots {
  // The characters on the current row, whether the dots are the last thing written, and the
  // failed files, printed after them.
  let row = 0
  let afterDots = false
  let held: string[] = []

  return {
    async mark(state) {
      const mark =
        state === 'pass' ? style.green('.') : state === 'fail' ? style.red('F') : style.yellow('-')
      row++
      afterDots = true
      if (row >= columns) {
        row = 0
        await stream.write(`${mark}\n`)
      } else {
        await stream.write(mark)
      }
    },

    async leave() {
      if (!afterDots) return ''
      afterDots = false
      if (row > 0) {
        row = 0
        await stream.write('\n')
      }
      return '\n'
    },

    defer(text) {
      held.push(text)
    },

    deferred: () => held.join('\n'),

    reset() {
      row = 0
      afterDots = false
      held = []
    },
  }
}
