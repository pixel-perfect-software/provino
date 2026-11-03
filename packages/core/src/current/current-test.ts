// The current-test service (T5.5, Track 5 decision 5). This is the only module that imports
// `node:async_hooks`. One AsyncLocalStorage, constructed when core loads: constructing one
// lazily, with `--no-async-context-frame` on Node 24+, made unrelated awaits about 4× slower
// (Track 5 Spikes A).
import { AsyncLocalStorage } from 'node:async_hooks'
import { debuglog } from 'node:util'
import type { CurrentTest, Frame } from '@provino/types'
import type { Store } from '../internal/model.ts'

const storage: AsyncLocalStorage<Store> = new AsyncLocalStorage<Store>()
const debug = debuglog('provino:core')

/** Runs `fn` with `store` as the current store. */
export function runInStore<R>(store: Store, fn: () => R): R {
  return storage.run(store, fn)
}

/** The current store, if any. */
export function currentStore(): Store | undefined {
  return storage.getStore()
}

/** A store that only carries a `Frame` (what external callers of `currentTest.run` give). */
function frameStore(frame: Frame): Store {
  return { frame, lazy: undefined, collecting: undefined, attempt: undefined, hook: undefined }
}

let running: Frame | undefined

/**
 * Sets the sync pointer: the frame the executor is running when only one test runs at a time.
 * The executor clears it (sets `undefined`) whenever more than one may run.
 */
export function setRunningFrame(frame: Frame | undefined): void {
  running = frame
}

/**
 * The current-test lookup, plus `running()`: the sync fast path.
 * @public
 */
export interface CurrentTestService extends CurrentTest {
  /**
   * The frame the executor is running right now, without an AsyncLocalStorage read. Only set
   * while tests run one at a time (`maxConcurrency` 1 or no concurrent group); `undefined`
   * otherwise. Code that needs the test that *started* some work must use `get()`.
   */
  running(): Frame | undefined
}

/**
 * The worker's one current-test lookup. Mocks and timers (attribution), lazy values and expect
 * state read it.
 * @public
 */
export const currentTest: CurrentTestService = {
  run<R>(frame: Frame, fn: () => R): R {
    return storage.run(frameStore(frame), fn)
  },
  get(): Frame | undefined {
    return storage.getStore()?.frame
  },
  bind<F extends (...args: never[]) => unknown>(fn: F): F {
    return AsyncLocalStorage.bind(fn)
  },
  running(): Frame | undefined {
    return running
  },
}

/**
 * Whether this process's AsyncLocalStorage runs on AsyncContextFrame: the default on Node 24+,
 * behind `--experimental-async-context-frame` on Node 22. Without it, every extra `await` costs
 * about 95 ns once a store is active (Track 5 Spikes A).
 * @internal
 */
export function usesAsyncContextFrame(
  version: string = process.versions.node,
  flags: readonly string[] = [...process.execArgv, ...nodeOptions()],
): boolean {
  if (flags.includes('--no-async-context-frame')) return false
  if (flags.includes('--experimental-async-context-frame')) return true
  return Number.parseInt(version, 10) >= 24
}

function nodeOptions(): string[] {
  return (process.env.NODE_OPTIONS ?? '').split(/\s+/).filter((flag) => flag !== '')
}

let reported = false

/** Logs, once and only under `NODE_DEBUG=provino:core`, which AsyncLocalStorage this is. */
export function reportAsyncContext(): void {
  if (reported) return
  reported = true
  if (usesAsyncContextFrame()) {
    debug('AsyncLocalStorage uses AsyncContextFrame')
  } else if ([...process.execArgv, ...nodeOptions()].includes('--no-async-context-frame')) {
    debug('--no-async-context-frame is set: every await pays the async_hooks cost')
  } else {
    debug(
      'AsyncLocalStorage uses async_hooks (Node 22 default); --experimental-async-context-frame opts in',
    )
  }
}
