// The dot reporter's row of characters: one per test as it ends (`.` passed, `F` failed, `-`
// skipped or todo), wrapped at the terminal's width, with the text that belongs under the dots
// (the failed files, an `error` event, the totals) held back or moved down to start a line of its
// own. A sibling of `live.ts`: that one redraws a block in place, this one only appends.
import type { TaskState } from '@provino/types'
import type { TextSink } from '../sink.ts'
import type { Style } from '../style.ts'

/** The row of dots a text reporter writes in `dot` mode. */
export interface Dots {
  /**
   * Adds the mark for a test that ended in `state` to the row. It is written once the row is full
   * (the promise), or by `flush`, so a file of many tests is a few writes, not one each.
   */
  mark(state: TaskState): Promise<void> | undefined
  /** Writes the marks held so far (at the end of a file, and before any other write). */
  flush(): Promise<void>
  /**
   * Before text goes under the dots: writes the marks held and ends the row so the text doesn't
   * land in the middle of it. Returns what that text starts with to leave a blank line under the
   * dots: `'\n'`, or `''` when the dots are not the last thing written.
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
  const marks = { pass: style.green('.'), fail: style.red('F'), other: style.yellow('-') }
  // The marks not written yet, how many characters are on the current row (written or not),
  // whether the dots are the last thing written, and the failed files, printed after them.
  let pending = ''
  let row = 0
  let afterDots = false
  let held: string[] = []

  async function flush(): Promise<void> {
    if (pending === '') return
    const text = pending
    pending = ''
    await stream.write(text)
  }

  return {
    mark(state) {
      pending += state === 'pass' ? marks.pass : state === 'fail' ? marks.fail : marks.other
      row++
      afterDots = true
      if (row < columns) return undefined
      row = 0
      pending += '\n'
      return flush()
    },

    flush,

    async leave() {
      if (!afterDots) return ''
      afterDots = false
      if (row > 0) {
        row = 0
        pending += '\n'
      }
      await flush()
      return '\n'
    },

    defer(text) {
      held.push(text)
    },

    deferred: () => held.join('\n'),

    reset() {
      pending = ''
      row = 0
      afterDots = false
      held = []
    },
  }
}
