// Timers taken once, at load: fake timers a test file installs later (on the globals or on
// `node:timers`) can't stall the worker's own flushes.
import { performance } from 'node:perf_hooks'
import * as timers from 'node:timers'

/** The real `setImmediate`. */
export const nativeSetImmediate: typeof timers.setImmediate = timers.setImmediate
/** The real `setTimeout`. */
export const nativeSetTimeout: typeof timers.setTimeout = timers.setTimeout

/**
 * The worker's own clock: `node:perf_hooks`' `performance`, which a window populated onto the
 * global (jsdom's `performance`) can't replace.
 */
export const nativeNow: () => number = performance.now.bind(performance)

/** Resolves on the next macrotask, so every pending microtask has run first. */
export function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => nativeSetImmediate(resolve))
}
