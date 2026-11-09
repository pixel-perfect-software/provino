// The two ends of the policy space, for this package's tests: the neutral `timers` slice, and one
// with every key the other way. The shape isn't a claim about any runner: the dialects and the
// harness's timer corpus own that. `makeEnv` builds a stand-in global, so a test never fakes the
// timers `node:test` itself runs on.
import { neutralPolicy } from '@provino/policy'
import type { TimersPolicy } from '@provino/types'

/** The neutral slice: Vitest-like names and throwing, every key as the neutral policy has it. */
export const neutral: TimersPolicy = neutralPolicy.timers

/** Every key the other way from `neutral`. */
export const flipped: TimersPolicy = {
  toFakeDefault: 'all',
  loopLimit: 100000,
  fakeTemporal: false,
  legacyAvailable: true,
  enableGlobally: true,
  optionNames: 'do-not-fake',
  notFaked: 'warn',
  setSystemTimeWithoutFakes: 'warn-noop',
  advanceToNextTimerHonorsSteps: false,
  facadeReturns: 'lifecycle',
  messages: { notFaked: 'flipped: timers are real.\nStack Trace:\n{stack}' },
}

/** What a stand-in global holds besides its timers. */
export interface TestEnv {
  readonly env: typeof globalThis & Record<string, unknown>
  readonly warnings: string[]
}

/**
 * A stand-in for an environment global: the real timers, `Date`, `process.nextTick` and
 * `queueMicrotask`, and a `console` whose `warn` records into `warnings`. Each call gives a fresh
 * object, so installing a clock on one leaves the process's own timers alone.
 */
export function makeEnv(extra: object = {}): TestEnv {
  const warnings: string[] = []
  const env = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    queueMicrotask,
    Date,
    performance,
    Promise,
    process: { nextTick: process.nextTick.bind(process), hrtime: process.hrtime },
    console: { warn: (text: string): void => void warnings.push(text) },
    ...extra,
  }
  return { env: env as unknown as TestEnv['env'], warnings }
}
