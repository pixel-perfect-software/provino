// `expect.poll` (T7.8, Track 7 F7): `await expect.poll(() => read(), { interval, timeout }).toBe(3)`
// calls the function again every `interval` ms until the matcher passes, and gives up after
// `timeout` ms. Vitest 5.0's behaviour, written against the engine's own matcher path so a
// dialect's matchers, custom matchers and `this` context all work as they do without `poll`.
//
// - The poll is lazy: nothing runs until the result is awaited (`then`/`catch`/`finally`). A poll
//   nobody awaits is reported at the test's end instead (`PendingAssertion`, `kind: 'poll'`),
//   when the worker tracks unawaited assertions; otherwise it starts at once, like an unawaited
//   `.resolves`.
// - A failed try is not an assertion call: the counters go back, so `expect.assertions(1)` holds
//   for a poll that needed ten tries.
// - The timeout is a real timer (captured when the engine is built, so fake timers can't stall
//   it). When the file's fake clock is installed the worker supplies `advance`, and the poll
//   moves it by `interval` after each wait, so a polled callback that reads fake time sees it pass.
// - On timeout the last error is thrown with the stack of the line that called the matcher, or,
//   under `pollFailsOnTimeout: false`, the poll just ends.
import type {
  ExpectMessages,
  ExpectPolicy,
  MatcherCall,
  MatcherState,
  PendingAssertion,
  PollAssertion,
  PollContext,
  PollOptions,
} from '@provino/types'
import { ExpectError } from './errors.ts'
import { awaitable } from './internal/awaitable.ts'

/**
 * The clocks `expect.poll` waits with. Everything is optional: it falls back to the real timers
 * that were on `globalThis` when the engine was built, and to no fake clock.
 * @public
 */
export interface PollTimers {
  /** Starts a timer. Default: the real `setTimeout`. */
  readonly setTimeout?: (callback: () => void, ms: number) => unknown
  /** Cancels a timer `setTimeout` returned. Default: the real `clearTimeout`. */
  readonly clearTimeout?: (handle: unknown) => void
  /**
   * Moves the file's fake clock forward by `ms`; returns `undefined` when none is installed. The
   * poll calls it after each wait between tries, as Vitest does.
   */
  readonly advance?: (ms: number) => Promise<void> | undefined
}

/** A function whose frame, and every frame above it, a captured error leaves out. */
type Caller = (...args: never[]) => unknown

/**
 * What `createPoll` needs from the engine around it.
 * @internal
 */
export interface PollEngine {
  readonly policy: ExpectPolicy
  readonly messages: ExpectMessages
  readonly timers: PollTimers | undefined
  /** Whether unawaited assertions are tracked (`CorePolicy.unawaitedAsyncAssertion: 'fail'`). */
  readonly track: boolean
  readonly state: () => MatcherState
  /** Whether a test (not just a file) is running. */
  readonly inTest: () => boolean
  readonly hasMatcher: (name: string) => boolean
  /** An error whose stack starts above `above`: where the user called the matcher. */
  readonly capture: (above: Caller) => Error
  /** One try: the named matcher on `value`, counting into `state`. Throws the failure. */
  readonly run: (
    name: string,
    isNot: boolean,
    value: unknown,
    args: readonly unknown[],
    state: MatcherState,
  ) => unknown
}

/** Matchers that cannot work with a poll: they would never pass, or they snapshot. */
const UNSUPPORTED: ReadonlySet<string> = new Set([
  'resolves',
  'rejects',
  'toMatchSnapshot',
  'toMatchInlineSnapshot',
  'toThrowErrorMatchingSnapshot',
  'toThrowErrorMatchingInlineSnapshot',
  'toThrow',
  'toThrowError',
])

type Raced<T> = { readonly ok: true; readonly value: T } | { readonly ok: false }

/** `promise`'s outcome, or `{ ok: false }` once `timedOut` settles first. */
function raceWith<T>(promise: Promise<T>, timedOut: Promise<void>): Promise<Raced<T>> {
  return Promise.race([
    promise.then((value): Raced<T> => ({ ok: true, value })),
    timedOut.then((): Raced<T> => ({ ok: false })),
  ])
}

/**
 * Gives `error` the stack of `site` (where the user called the matcher), under its own header,
 * as Vitest's `copyStackTrace` does. Anything that isn't an `Error` is returned as it is.
 */
function restack(error: unknown, site: Error): unknown {
  if (!(error instanceof Error) || typeof site.stack !== 'string') return error
  const frames = site.stack.split('\n').filter((line) => /^\s+at /.test(line))
  error.stack = `${error.name}: ${error.message}\n${frames.join('\n')}`
  return error
}

/** A time in milliseconds that `setTimeout` accepts. */
function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Builds `expect.poll` for one engine.
 * @internal
 */
export function createPoll(
  engine: PollEngine,
): (fn: (context: PollContext) => unknown, options?: PollOptions) => PollAssertion {
  const { policy, messages, timers } = engine
  // Taken now, not when a poll runs: a file may install fake timers over the globals later.
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const setTimer = timers?.setTimeout ?? ((callback, ms) => realSetTimeout(callback, ms))
  const clearTimer =
    timers?.clearTimeout ??
    ((handle) => {
      realClearTimeout(handle as ReturnType<typeof setTimeout>)
    })

  /** A wait of `ms`, and a way to cancel its timer. */
  const wait = (ms: number): { readonly done: Promise<void>; readonly cancel: () => void } => {
    let handle: unknown
    const done = new Promise<void>((resolve) => {
      handle = setTimer(resolve, ms)
    })
    return { done, cancel: () => clearTimer(handle) }
  }

  /** One poll: `fn` and the matcher, again and again, until the matcher passes or time is up. */
  async function run(
    fn: (context: PollContext) => unknown,
    interval: number,
    timeout: number,
    name: string,
    isNot: boolean,
    args: readonly unknown[],
    state: MatcherState,
    site: Error,
  ): Promise<void> {
    const controller = new AbortController()
    const total = wait(timeout)
    const timedOut = total.done.then(() => {
      controller.abort()
    })
    let lastError: unknown
    let failed = false
    try {
      for (;;) {
        try {
          const read = await raceWith(
            Promise.resolve().then(() => fn({ signal: controller.signal })),
            timedOut,
          )
          if (!read.ok) {
            if (!failed) lastError = new Error(messages.pollTimeout('function'))
            failed = true
            break
          }
          const tried = await raceWith(
            Promise.resolve().then(() => {
              // Taken here, with nothing awaited between it and the matcher, so a failed try takes
              // back its own count and not one that other code made while `fn` was awaited.
              const before = state.assertionCalls
              try {
                return engine.run(name, isNot, read.value, args, state)
              } catch (error) {
                // A try that didn't pass doesn't count as an assertion.
                state.assertionCalls = before
                throw error
              }
            }),
            timedOut,
          )
          if (!tried.ok) {
            if (!failed) lastError = new Error(messages.pollTimeout('assertion'))
            failed = true
            break
          }
          return
        } catch (error) {
          lastError = error
          failed = true
          const nap = wait(interval)
          const slept = await raceWith(nap.done, timedOut)
          if (!slept.ok) {
            nap.cancel()
            break
          }
          await timers?.advance?.(interval)
        }
      }
    } finally {
      total.cancel()
    }
    if (policy.pollFailsOnTimeout && failed) throw restack(lastError, site)
  }

  /** The matcher a poll's proxy hands out for `name`. */
  const chain = (
    fn: (context: PollContext) => unknown,
    interval: number,
    timeout: number,
    name: string,
    isNot: boolean,
  ) =>
    function pollMatcher(...args: unknown[]): Promise<void> {
      const site = engine.capture(pollMatcher)
      const state = engine.state()
      const call: MatcherCall = { matcherName: name, isNot, promise: '' }
      let started: Promise<void> | undefined
      const start = (): Promise<void> =>
        (started ??= run(fn, interval, timeout, name, isNot, args, state, site))
      if (!engine.track) {
        // Nobody is told about a poll that isn't awaited, so it must at least run.
        return start()
      }
      const pending: PendingAssertion = { kind: 'poll', call, error: site }
      state.pendingAsync.add(pending)
      return awaitable(start, () => {
        state.pendingAsync.delete(pending)
      })
    }

  return function poll(fn, options = {}) {
    if (!engine.inTest()) {
      throw new ExpectError('EXPECT_OUTSIDE_TEST', messages.outsideTest('poll'))
    }
    if (typeof fn !== 'function') {
      throw new ExpectError(
        'EXPECT_INVALID_ARGUMENT',
        'expect.poll: the first argument must be a function',
      )
    }
    const interval = options.interval ?? policy.poll.intervalMs
    const timeout = options.timeout ?? policy.poll.timeoutMs
    if (!isTime(interval) || !isTime(timeout)) {
      throw new ExpectError(
        'EXPECT_INVALID_ARGUMENT',
        'expect.poll: interval and timeout must be times in milliseconds',
      )
    }
    const voice = (isNot: boolean): object =>
      new Proxy(
        {},
        {
          get(_target, key, receiver) {
            if (typeof key !== 'string') return undefined
            if (key === 'not' && !isNot) return voice(true)
            if (UNSUPPORTED.has(key)) {
              throw new ExpectError('EXPECT_POLL_UNSUPPORTED', messages.pollUnsupported(key))
            }
            if (!engine.hasMatcher(key)) return Reflect.get(Object.prototype, key, receiver)
            return chain(fn, interval, timeout, key, isNot)
          },
        },
      )
    return voice(false) as PollAssertion
  }
}
