// Lazy locations (Track 5 decision 11): capture a short callsite at registration, parse it only
// when the tree is emitted. Reading `.stack` is the expensive part (about 8 µs), so it happens
// once per task and hook, after collection, and only when locations are wanted.
import { fileURLToPath } from 'node:url'
import type { SourceLocation } from '@provino/types'

/**
 * Any function or class: the API function `captureStackTrace` cuts the user's frames at, and what
 * a test or describe may be named after.
 */
// biome-ignore lint/complexity/noBannedTypes: any function or class, callable or not
export type StackMarker = Function

/** A captured callsite, not yet parsed. */
export interface Site {
  readonly stack?: string
}

/** Frames kept for the caller frame alone. */
export const CALLER_FRAMES = 3
/**
 * Frames kept when the location is the first frame in the test file, so a test a helper registers
 * still reaches the helper's call site (Vitest keeps 10 for a test and 15 for a suite, counting its
 * own frames; ours start at the caller).
 */
export const TEST_FILE_FRAMES = 10

/**
 * Captures the caller of `entry` (the public API function the user called), keeping `frames`
 * frames. Returns `null` when locations are off.
 */
export function captureSite(
  entry: StackMarker,
  enabled: boolean,
  frames: number = CALLER_FRAMES,
): Site | null {
  if (!enabled) return null
  const holder: { stack?: string } = {}
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = frames
  Error.captureStackTrace(holder, entry)
  Error.stackTraceLimit = limit
  return holder
}

const FRAME = /^\s*at (?:.*? \()?(.+?):(\d+):(\d+)\)?\s*$/

/**
 * A captured site's location: the first frame in `testFile` when one is given and the stack has
 * one, otherwise the first frame. `null` when no frame has a position. `paths` memoizes each
 * frame's `toPath` across the sites of one file, where the same few files recur.
 */
export function parseSite(
  site: Site | null,
  testFile?: string,
  paths?: Map<string, string>,
): SourceLocation | null {
  const stack = site?.stack
  if (stack === undefined) return null
  let first: SourceLocation | null = null
  // The first line is the message; each frame is a line after it.
  for (let at = stack.indexOf('\n') + 1; at !== 0; ) {
    const end = stack.indexOf('\n', at)
    const match = FRAME.exec(end === -1 ? stack.slice(at) : stack.slice(at, end))
    at = end + 1
    if (match === null) continue
    const [, frameFile = '', lineText = '0', columnText = '0'] = match
    const file = pathOf(frameFile, paths)
    if (testFile !== undefined && file !== testFile) {
      first ??= { file, line: Number(lineText), column: Number(columnText) }
      continue
    }
    return { file, line: Number(lineText), column: Number(columnText) }
  }
  return first
}

function pathOf(frameFile: string, paths: Map<string, string> | undefined): string {
  if (paths === undefined) return toPath(frameFile)
  let path = paths.get(frameFile)
  if (path === undefined) {
    path = toPath(frameFile)
    paths.set(frameFile, path)
  }
  return path
}

/**
 * A frame's file as a path: a `file:` URL is decoded, and its query (a loader's cache buster such
 * as `?core-run=3`) and hash dropped. Anything else is kept as it is.
 */
export function toPath(file: string): string {
  if (!file.startsWith('file:')) return file
  try {
    return fileURLToPath(file)
  } catch {
    return file
  }
}
