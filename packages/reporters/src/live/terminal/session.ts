// A terminal session: the cursor, the synchronized update and the footer, with the one way back.
// The cursor is hidden on the first frame, and `restore()` (idempotent) ends any open synchronized
// update, erases the footer and shows the cursor again. Nothing is written by a session that never
// drew a frame.

import { BEGIN_SYNC, END_SYNC, HIDE_CURSOR, SHOW_CURSOR } from './ansi.ts'
import { createRegion } from './region.ts'
import type { TimedWriter } from './writer.ts'

/**
 * The terminal as the renderer sees it.
 * @beta
 */
export interface TerminalSession {
  /**
   * Draws a frame: `scrolled` lines above the footer, then `footer`, in one write wrapped in a
   * synchronized update. Returns false when nothing was written (no change, or the stream is not
   * ready, or the session is over). Nothing is consumed then: the caller keeps its lines.
   */
  draw(scrolled: readonly string[], footer: readonly string[]): boolean
  /**
   * The last write of a run: erases the footer, writes `lines`, shows the cursor again. The
   * session is over afterwards.
   */
  finish(lines: readonly string[]): void
  /** Erases the footer, shows the cursor and ends any open synchronized update. Writes once; a second call writes nothing. */
  restore(): void
  /** The terminal's width changed. */
  resize(columns: number): void
  /** Whether a footer is on screen. */
  readonly active: () => boolean
}

/**
 * Creates the session over `writer`, for a terminal `columns` wide.
 * @beta
 */
export function createTerminalSession(writer: TimedWriter, columns: number): TerminalSession {
  const region = createRegion(columns)
  let cursorHidden = false
  let syncOpen = false
  let over = false

  return {
    draw(scrolled, footer) {
      if (over || !writer.ready()) return false
      const body = region.render(scrolled, footer)
      if (body === '') return false
      const first = cursorHidden ? '' : HIDE_CURSOR
      syncOpen = true
      const written = writer.write(`${BEGIN_SYNC}${first}${body}${END_SYNC}`)
      if (written) {
        syncOpen = false
        cursorHidden = true
      }
      return written
    },
    finish(lines) {
      if (over) return
      over = true
      let out = region.erase()
      for (const line of lines) out += `${line}\n`
      if (cursorHidden) out += SHOW_CURSOR
      cursorHidden = false
      syncOpen = false
      if (out !== '') writer.writeSync(out)
    },
    restore() {
      if (over) return
      over = true
      const out = (syncOpen ? END_SYNC : '') + region.erase() + (cursorHidden ? SHOW_CURSOR : '')
      cursorHidden = false
      syncOpen = false
      if (out !== '') writer.writeSync(out)
    },
    resize: (width) => region.resize(width),
    active: () => region.height() > 0,
  }
}
