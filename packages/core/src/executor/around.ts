// `aroundEach`/`aroundAll` (neutral features in every dialect, Track 5 decision 3), following
// Vitest 5.0's `callAroundHooks`: the first registered hook is outermost; each hook gets an inner
// function to call exactly once; setup and teardown are timed separately; a hook that never calls
// its inner function fails with `AroundHookSetupError`.
import {
  AroundHookMultipleCallsError,
  AroundHookSetupError,
  AroundHookTeardownError,
} from '../errors.ts'
import type { RealTimers } from './deadline.ts'

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

  const runFrom = async (index: number): Promise<void> => {
    const hook = hooks[index]
    if (hook === undefined) return inner()
    let used = false
    let setupTimedOut = false
    const usedSignal = Promise.withResolvers<void>()
    const returnedSignal = Promise.withResolvers<void>()
    const setup = phaseTimer(hook.timeoutMs, options, 'setup', () => {
      setupTimedOut = true
    })
    let teardown: PhaseTimer | undefined
    const use = async (): Promise<void> => {
      if (setupTimedOut) throw new Error('the setup phase already timed out')
      if (used) {
        throw new AroundHookMultipleCallsError(
          `The \`${callback}\` callback was called multiple times in the \`${options.kind}\` hook. The callback can only be called once per hook.`,
        )
      }
      used = true
      setup.clear()
      usedSignal.resolve()
      await runFrom(index + 1).catch((error: unknown) => {
        errors.push(error)
      })
      teardown = phaseTimer(hook.timeoutMs, options, 'teardown')
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
      await Promise.race([usedSignal.promise, completed, setup.expired])
    } finally {
      setup.clear()
    }
    await Promise.race([returnedSignal.promise, completed])
    try {
      await Promise.race([completed, teardown?.expired ?? completed])
    } finally {
      teardown?.clear()
    }
  }

  await runFrom(0).catch((error: unknown) => {
    errors.push(error)
  })
  return errors
}

interface PhaseTimer {
  /** Rejects with the phase's timeout error when the phase runs out of time; never resolves. */
  readonly expired: Promise<never>
  clear(): void
}

function phaseTimer(
  timeoutMs: number,
  options: AroundOptions,
  phase: 'setup' | 'teardown',
  onExpire?: () => void,
): PhaseTimer {
  const { promise, reject } = Promise.withResolvers<never>()
  promise.catch(() => undefined)
  if (!(timeoutMs > 0 && Number.isFinite(timeoutMs))) return { expired: promise, clear: () => {} }
  const timer = options.timers.setTimeout(() => {
    const ErrorClass = phase === 'setup' ? AroundHookSetupError : AroundHookTeardownError
    const error = new ErrorClass(
      `The ${phase} phase of "${options.kind}" hook timed out after ${timeoutMs}ms.`,
    )
    onExpire?.()
    options.onTimeout?.(error)
    reject(error)
  }, timeoutMs)
  return { expired: promise, clear: () => options.timers.clearTimeout(timer) }
}
