// The timers a file sets on a Jest window environment die with its window, as in Jest: there the
// test's global is the jsdom window, its `setTimeout` and `setInterval` are jsdom's own, and
// jest-environment-jsdom's teardown calls `window.close()`, which cancels every one still pending
// (and the window has no `setImmediate`). Here the window is populated onto the worker's global,
// whose timers are Node's, so a timer a file's last test left (an effect's cleanup after unmount,
// a state update from a timer, React's scheduler) would fire after the restore deleted `window`,
// with `ReferenceError: window is not defined`.
//
// One wrapper per timer function is put on the global once per worker, when the adapter is
// prepared, before a test file loads anything: a shared package that captures `setTimeout` or
// `setImmediate` as it loads (`scheduler`) captures the wrapper, the same one in every file, so the
// timers are no per-file global (D129) and nothing is evaluated again for them. While a window
// file runs, the wrapper notes each handle it hands out; the file's teardown cancels the ones still
// pending. Outside a window file it only calls Node's timer.
import { promisify } from 'node:util'

/** The per-worker wrappers: `begin` at a window file's setup, `cancelPending` at its teardown. */
export interface WindowTimers {
  /** Starts noting the timers set through the global, for the file being set up. */
  begin(): void
  /** Cancels every timer noted since `begin` that is still pending, and stops noting. */
  cancelPending(): void
}

type Callback = (...args: unknown[]) => unknown
type Schedule = (callback: Callback, ...rest: unknown[]) => unknown
type Clear = (handle: unknown) => void

interface Pair {
  readonly set: string
  readonly clear: string
}

const PAIRS: readonly Pair[] = [
  { set: 'setTimeout', clear: 'clearTimeout' },
  { set: 'setInterval', clear: 'clearInterval' },
  { set: 'setImmediate', clear: 'clearImmediate' },
]

/** The wrappers already on a global: installing twice would wrap the wrappers. */
const installed = new WeakMap<object, WindowTimers>()

function functionOn(global: Record<string, unknown>, key: string): Callback | undefined {
  const value = global[key]
  return typeof value === 'function' ? (value as Callback) : undefined
}

/**
 * Puts the wrappers on `global` (once per global; a second call returns the first's), keeping
 * each original's name and `util.promisify.custom` (the promise form is not noted: Jest's window
 * has none).
 */
export function installWindowTimers(global: object = globalThis): WindowTimers {
  const known = installed.get(global)
  if (known !== undefined) return known
  const target = global as Record<string, unknown>
  // The handles of the file being run, with how to cancel each; `null` outside a window file.
  let pending: Map<unknown, Clear> | null = null

  for (const { set, clear } of PAIRS) {
    const original = functionOn(target, set) as Schedule | undefined
    const originalClear = functionOn(target, clear) as Clear | undefined
    if (original === undefined || originalClear === undefined) continue
    const once = set !== 'setInterval'
    const wrapped = {
      [set](this: unknown, callback: Callback, ...rest: unknown[]): unknown {
        const noting = pending
        if (noting === null || typeof callback !== 'function') {
          return Reflect.apply(original, this, [callback, ...rest])
        }
        let handle: unknown
        const run = once
          ? function (this: unknown, ...args: unknown[]): unknown {
              noting.delete(handle)
              return Reflect.apply(callback, this, args)
            }
          : callback
        handle = Reflect.apply(original, this, [run, ...rest])
        noting.set(handle, originalClear)
        return handle
      },
    }[set] as Schedule
    const wrappedClear = {
      [clear](this: unknown, handle: unknown): void {
        pending?.delete(handle)
        Reflect.apply(originalClear, this, [handle])
      },
    }[clear] as Clear
    const custom = (original as unknown as Record<symbol, unknown>)[promisify.custom]
    if (custom !== undefined) {
      Object.defineProperty(wrapped, promisify.custom, {
        value: custom,
        writable: false,
        enumerable: false,
        configurable: true,
      })
    }
    replace(target, set, wrapped)
    replace(target, clear, wrappedClear)
  }

  const timers: WindowTimers = {
    begin() {
      pending = new Map()
    },
    cancelPending() {
      const noted = pending
      pending = null
      if (noted === null) return
      for (const [handle, cancel] of noted) cancel(handle)
    },
  }
  installed.set(global, timers)
  return timers
}

/** Redefines `key` with its own descriptor's attributes, so only the value changes. */
function replace(target: Record<string, unknown>, key: string, value: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  if (descriptor === undefined || !('value' in descriptor)) {
    target[key] = value
    return
  }
  Object.defineProperty(target, key, { ...descriptor, value })
}
