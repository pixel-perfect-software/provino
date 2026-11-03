// Lazy locations (Track 5 decision 11): capture a 3-frame callsite at registration, parse it only
// when the tree is emitted. Reading `.stack` is the expensive part (about 8 µs), so it happens
// once per task, after collection, and only when locations are wanted.
import { fileURLToPath } from 'node:url'
import type { SourceLocation } from '@provino/types'

/** A captured callsite, not yet parsed. */
export interface Site {
  readonly stack?: string
}

/**
 * Captures the caller of `entry` (the public API function the user called), keeping 3 frames.
 * Returns `null` when locations are off.
 */
// biome-ignore lint/complexity/noBannedTypes: `captureStackTrace` takes any function as its marker
export function captureSite(entry: Function, enabled: boolean): Site | null {
  if (!enabled) return null
  const holder: { stack?: string } = {}
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = 3
  Error.captureStackTrace(holder, entry)
  Error.stackTraceLimit = limit
  return holder
}

const FRAME = /^\s*at (?:.*? \()?(.+?):(\d+):(\d+)\)?\s*$/

/** The first frame of a captured site, or `null` when it has none with a position. */
export function parseSite(site: Site | null): SourceLocation | null {
  const stack = site?.stack
  if (stack === undefined) return null
  for (const line of stack.split('\n').slice(1)) {
    const match = FRAME.exec(line)
    if (match === null) continue
    const [, file = '', lineText = '0', columnText = '0'] = match
    return { file: toPath(file), line: Number(lineText), column: Number(columnText) }
  }
  return null
}

function toPath(file: string): string {
  if (!file.startsWith('file:')) return file
  try {
    return fileURLToPath(file)
  } catch {
    return file
  }
}
