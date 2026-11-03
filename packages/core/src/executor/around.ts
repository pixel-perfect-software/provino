// `aroundEach`/`aroundAll` (neutral features in every dialect, Track 5 decision 3), following
// Vitest 5.0's `callAroundHooks`: the first registered hook is outermost; each hook gets an inner
// function to call exactly once; setup and teardown are timed separately; a hook that never calls
// its inner function fails with `AroundHookSetupError`.
import {
  AroundHookMultipleCallsError,
  AroundHookSetupError,
  AroundHookTeardownError,
} from '../errors.ts'
import { armDeadline, isBounded, type RealTimers } from './deadline.ts'

/** One around hook, ready to call. */
export interface AroundCall {
  /** Calls the hook with its inner function; settles when the hook's own code is done. */
  readonly invoke: (inner: () => Promise<void>) => unknown
  readonly timeoutMs: number
}

/** What the around chain needs. */
export interface AroundOptions {
  readonly kind: 'aroundEach' | 'aroundAll'
  readonly timers: RealTimers
  /** Called when a phase times out (aborts the test's signal for `aroundEach`). */
  readonly onTimeout?: (error: Error) => void
}

/** A running phase's deadline. */
interface Phase {
  /** Rejects with the phase's timeout error when the phase runs out of time; never resolves. */
  readonly expired: Promise<never>
  readonly clear: () => void
}

/**
 * Runs `inner` wrapped by `hooks`, outermost first. Returns every error the hooks raised, in the
 * order they happened; errors from `inner` are its own business.
 */
export async function runAround(
  hooks: readonly AroundCall[],
  inner: () => Promise<void>,
  options: AroundOptions,
): Promise<unknown[]> {
  const errors: unknown[] = []
  const callback = options.kind === 'aroundEach' ? 'runTest()' : 'runSuite()'
  const target = options.kind === 'aroundEach' ? 'test' : 'suite'

  /** A phase's deadline, or `undefined` when its timeout sets none. */
  const phase = (
    timeoutMs: number,
    name: 'setup' | 'teardown',
    onExpire?: () => void,
  ): Phase | undefined => {
    if (!isBounded(timeoutMs)) return undefined
    const { promise, reject } = Promise.withResolvers<never>()
    // A phase that expires after its hook has settled is raced by no one.
    promise.catch(() => undefined)
    const clear = armDeadline(timeoutMs, options.timers, () => {
      const ErrorClass = name === 'setup' ? AroundHookSetupError : AroundHookTeardownError
      const error = new ErrorClass(
        `The ${name} phase of "${options.kind}" hook timed out after ${timeoutMs}ms.`,
      )
      onExpire?.()
      options.onTimeout?.(error)
      reject(error)
    })
    return { expired: promise, clear }
  }

  const runFrom = async (index: number): Promise<void> => {
    const hook = hooks[index]
    if (hook === undefined) return inner()
    let used = false
    let setupTimedOut = false
    /** The inner function has run and returned: the hook's code from here on is its teardown. */
    let returned = false
    const usedSignal = Promise.withResolvers<void>()
    const returnedSignal = Promise.withResolvers<void>()
    const setup = phase(hook.timeoutMs, 'setup', () => {
      setupTimedOut = true
    })
    const use = async (): Promise<void> => {
      if (setupTimedOut) throw new Error('the setup phase already timed out')
      if (used) {
        throw new AroundHookMultipleCallsError(
          `The \`${callback}\` callback was called multiple times in the \`${options.kind}\` hook. The callback can only be called once per hook.`,
        )
      }
      used = true
      setup?.clear()
      usedSignal.resolve()
      await runFrom(index + 1).catch((error: unknown) => {
        errors.push(error)
      })
      returned = true
      returnedSignal.resolve()
    }
    const completed = (async () => {
      await hook.invoke(use)
      if (!used) {
        throw new AroundHookSetupError(
          `The \`${callback}\` callback was not called in the \`${options.kind}\` hook. Make sure to call \`${callback}\` to run the ${target}.`,
        )
      }
    })()
    // A rejection is handled by one of the races below; this keeps it from counting as unhandled
    // while the inner function still runs.
    completed.catch(() => undefined)
    try {
      await Promise.race(
        setup === undefined
          ? [usedSignal.promise, completed]
          : [usedSignal.promise, completed, setup.expired],
      )
    } finally {
      setup?.clear()
    }
    await Promise.race([returnedSignal.promise, completed])
    // Only a hook still running after its inner function returned has a teardown phase to time: one
    // that didn't await the inner function has exited, and a timer armed for it would never be
    // cleared, and would abort a test that has finished.
    const teardown = returned ? phase(hook.timeoutMs, 'teardown') : undefined
    if (teardown === undefined) {
      await completed
      return
    }
    try {
      await Promise.race([completed, teardown.expired])
    } finally {
      teardown.clear()
    }
  }

  await runFrom(0).catch((error: unknown) => {
    errors.push(error)
  })
  return errors
}
