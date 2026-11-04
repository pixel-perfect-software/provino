// Timers taken once, at load: fake timers a test file installs later (on the globals or on
// `node:timers`) can't stall the worker's own flushes.
import * as timers from 'node:timers'

/** The real `setImmediate`. */
export const nativeSetImmediate: typeof timers.setImmediate = timers.setImmediate
/** The real `setTimeout`. */
export const nativeSetTimeout: typeof timers.setTimeout = timers.setTimeout

/** Resolves on the next macrotask, so every pending microtask has run first. */
export function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => nativeSetImmediate(resolve))
}
