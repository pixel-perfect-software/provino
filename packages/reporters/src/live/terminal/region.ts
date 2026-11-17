// The footer: a block of lines at the bottom of the output that is redrawn in place. The region
// remembers the lines it last drew and returns the one string that brings the screen to the next
// state, with the cursor left at the start of the line below the footer, where it started.
//
// - Lines to scroll above the footer, or a footer whose height changed: move up over the old
//   footer, erase down, write the scrolled lines, then the footer whole.
// - Otherwise: move up, and rewrite only the footer lines that changed (erase the line, write it)
//   stepping over the rest.
//
// Every footer line is cut to `columns - 1`, so no line wraps and the number of lines on screen is
// the number of lines drawn. Scrolled lines are written as given: they leave the footer's reach.

import { cursorDown, cursorUp, ERASE_DOWN, ERASE_LINE } from './ansi.ts'
import { displayWidth, fitWidth } from './width.ts'

/**
 * The footer as it is on screen.
 * @beta
 */
export interface Region {
  /** The string that scrolls `scrolled` above the footer and draws `footer`. Empty when nothing changed. */
  render(scrolled: readonly string[], footer: readonly string[]): string
  /** The string that erases the footer, and forgets it. Empty when none is drawn. */
  erase(): string
  /** The terminal's width changed: the next render redraws the footer whole. */
  resize(columns: number): void
  /** How many lines the footer is on screen. */
  height(): number
}

/**
 * Creates a region for a terminal `columns` wide.
 * @beta
 */
export function createRegion(columns: number): Region {
  let width = Math.max(1, columns - 1)
  let drawn: readonly string[] = []
  let redraw = false
  /** The terminal's width after a resize, until the footer is erased: the old lines reflowed to it. */
  let reflowedTo: number | undefined

  /** How many screen rows the drawn lines occupy: one each, unless a resize narrowed the terminal under them. */
  function rows(): number {
    if (reflowedTo === undefined) return drawn.length
    let total = 0
    for (const line of drawn) total += Math.max(1, Math.ceil(displayWidth(line) / reflowedTo))
    return total
  }

  function eraseOld(): string {
    const count = rows()
    reflowedTo = undefined
    return count === 0 ? '' : `${cursorUp(count)}${ERASE_DOWN}`
  }

  return {
    render(scrolled, footer) {
      const lines = footer.map((line) => fitWidth(line, width))
      if (scrolled.length > 0 || lines.length !== drawn.length || redraw) {
        redraw = false
        let out = eraseOld()
        for (const line of scrolled) out += `${line}\n`
        for (const line of lines) out += `${line}\n`
        drawn = lines
        return out
      }
      let out = ''
      let skipped = 0
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === drawn[i]) {
          skipped++
          continue
        }
        out += skipped > 0 ? cursorDown(skipped) : ''
        skipped = 0
        out += `${ERASE_LINE}${lines[i]}${cursorDown(1)}`
      }
      if (out === '') return ''
      // Up over the whole footer first; the trailing unchanged lines are stepped over at the end.
      out = cursorUp(lines.length) + out + (skipped > 0 ? cursorDown(skipped) : '')
      drawn = lines
      return out
    },
    erase() {
      const out = eraseOld()
      drawn = []
      return out
    },
    resize(columns) {
      width = Math.max(1, columns - 1)
      if (drawn.length > 0) reflowedTo = Math.max(1, columns)
      redraw = true
    },
    height: () => drawn.length,
  }
}
