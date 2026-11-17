// What a running file keeps of an error is bounded by size, not only by count (performance rule 4):
// each string is cut at `MAX_ERROR_STRING` and copied flat, so the cut does not keep the original
// (a slice of a string shares its parent's memory), nested errors stop at three levels and five a
// level, and the fields no frame reads (`details`, the diff's two sides) are not kept at all.

import type { SerializedError } from '@provino/types'

/** The longest string kept of an error's name, message or stack, in characters. */
export const MAX_ERROR_STRING: number = 16 * 1024
const MAX_DEPTH = 3
const MAX_NESTED = 5

/**
 * A copy of `text` in memory of its own. A slice of a string shares its parent's memory (V8 keeps
 * the whole of a long message alive for a short first line cut from it), so what is kept long
 * after the parent is gone is copied.
 */
export function copyFlat(text: string): string {
  return Buffer.from(text, 'utf8').toString('utf8')
}

function flat(text: string): string {
  if (text.length <= MAX_ERROR_STRING) return text
  return copyFlat(text.slice(0, MAX_ERROR_STRING))
}

/**
 * The part of `error` a frame reads, with every string bounded.
 * @beta
 */
export function boundError(error: SerializedError, depth = 0): SerializedError {
  return {
    name: flat(error.name),
    message: flat(error.message),
    ...(error.stack === undefined ? {} : { stack: flat(error.stack) }),
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.location === undefined ? {} : { location: error.location }),
    ...(depth >= MAX_DEPTH || error.cause === undefined
      ? {}
      : { cause: boundError(error.cause, depth + 1) }),
    ...(depth >= MAX_DEPTH || error.errors === undefined
      ? {}
      : { errors: error.errors.slice(0, MAX_NESTED).map((each) => boundError(each, depth + 1)) }),
  }
}

/**
 * `errors` bounded: at most ten, each through `boundError`. The same array when there are none.
 * @beta
 */
export function boundErrors(errors: readonly SerializedError[]): readonly SerializedError[] {
  return errors.length === 0 ? errors : errors.slice(0, 10).map((error) => boundError(error))
}
