// Number and time text, and the one rule for a status's glyph, that the footer and the views share.
// Plain functions, no `Intl`: they run in a frame. The count text (`groupDigits`, `plural`) is
// `internal/views/count.ts`, which the folder helpers use too, and is exported from here.

import type { FileKind } from '../../internal/views/folders.ts'
import type { Glyphs } from '../terminal/glyphs.ts'

export { groupDigits, plural } from '../../internal/views/count.ts'

/** The mark of an outcome: the glyph a pass, a failure, a skip or a todo is drawn with. */
export function markOf(kind: FileKind, glyphs: Glyphs): string {
  switch (kind) {
    case 'fail':
      return glyphs.fail
    case 'skip':
      return glyphs.skipped
    case 'todo':
      return glyphs.todo
    default:
      return glyphs.pass
  }
}

/** A clock: `0.8s`, `12.4s`, `1m 05s`, `1h 02m`. Tenths of a second below a minute. */
export function clock(ms: number): string {
  const tenths = Math.max(0, Math.floor(ms / 100))
  if (tenths < 600) return `${Math.floor(tenths / 10)}.${tenths % 10}s`
  const seconds = Math.floor(tenths / 10)
  if (seconds < 3600) {
    const rest = seconds % 60
    return `${Math.floor(seconds / 60)}m ${rest < 10 ? '0' : ''}${rest}s`
  }
  const minutes = Math.floor(seconds / 60) % 60
  return `${Math.floor(seconds / 3600)}h ${minutes < 10 ? '0' : ''}${minutes}m`
}

/** A finished file's time: whole milliseconds under a second (`310ms`), else seconds (`1.24s`, `12.4s`, `1m 05s`). */
export function fileTime(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)}s`
  return clock(ms)
}

/** A rough time left: `8s`, `2m`, `1h`. Never more precise than it is. */
export function roughDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds / 3600)}h`
}
