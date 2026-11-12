// Test helpers (not a test file): spike E's interleaved tests (Track 7 §Spikes E), run through
// core's real runtime so `test.concurrent` and the current-test lookup are the worker's own.
import type { TestContext } from 'node:test'
import { createRuntime, currentTest, type RuntimeApi, type RuntimeOptions } from '@provino/core'
import {
  createExpect,
  createMatcherRegistry,
  createStateSource,
  installMatchersSlot,
  type StateSource,
} from '@provino/expect'
import { createBehaviourLoader, neutralPolicy, resolvePolicy } from '@provino/policy'
import { createFakeClock, type FakeClock, type FakeClockOptions } from '@provino/timers'
import type { ExpectStatic, RuntimeEvent, TimersPolicy } from '@provino/types'
import { jestPolicy } from '../../dialect.ts'
import { jestExpectPolicy } from '../../expect-policy.ts'
import { jestExpectTable } from '../expect-table.ts'

/** How many interleaved tests spike E runs, and the seed that fixes their interleaving. */
export const COUNT = 50
export const SEED = 20261103

/** What one test counted, read inside the test as it ends. */
export interface Counted {
  /** The `n` it passed to `expect.assertions(n)` and then asserted `n` times. */
  readonly n: number
  readonly assertionCalls: number
  readonly expectedAssertionsNumber: number | null
}

/** A test body: `expect.assertions(n)`, then `n` assertions with `pause()`s between them. */
export type CountingBody = (n: number, pause: () => Promise<void>) => Promise<Omit<Counted, 'n'>>

/** The part of `expect` a counting body uses: ours (`ExpectStatic`) and Jest's both fit. */
export interface CountingExpect {
  (actual: unknown): { toBe(expected: unknown): unknown }
  assertions(expected: number): void
  getState(): { readonly assertionCalls: number; readonly expectedAssertionsNumber: number | null }
}

/** `expect.assertions(n)`, `n` passing assertions with a pause before each, then what `expect` counted. */
export function countingBody(expect: CountingExpect): CountingBody {
  return async (n, pause) => {
    expect.assertions(n)
    for (let i = 0; i < n; i++) {
      await pause()
      expect(i).toBe(i)
    }
    await pause()
    const { assertionCalls, expectedAssertionsNumber } = expect.getState()
    return { assertionCalls, expectedAssertionsNumber }
  }
}

/** The tests that counted exactly the `n` assertions they declared and made. */
export function countedCorrectly(counted: readonly Counted[]): Counted[] {
  return counted.filter((c) => c.assertionCalls === c.n && c.expectedAssertionsNumber === c.n)
}

/** A small seeded generator (mulberry32), so the interleaving is the same every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Runs one test file whose tests `register` defines, through core's real runtime, and returns the
 * runtime's events.
 */
export async function runRegistered(
  register: (api: RuntimeApi) => void,
  policy: RuntimeOptions['policy'] = neutralPolicy.core,
): Promise<readonly RuntimeEvent[]> {
  const events: RuntimeEvent[] = []
  const runtime = await createRuntime({
    policy,
    behaviours: createBehaviourLoader(),
    sink: { emit: (event) => events.push(event) },
    importFile: async () => register(runtime.api),
    rootDir: '/registered',
  })
  try {
    await runtime.runFile('/registered/a.test.ts')
  } finally {
    await runtime.dispose()
  }
  return events
}

/**
 * Runs `count` `test.concurrent` tests at once through core's runtime. Test `i` asserts
 * `n` = 1–5 times (seeded), yielding 0–3 macrotasks (seeded) before each assertion, so the tests
 * interleave with no real-time wait. Returns what each counted and how many bodies ran at once.
 */
export async function runInterleaved(
  count: number,
  seed: number,
  body: CountingBody,
): Promise<{
  readonly counted: readonly Counted[]
  /** The most test bodies running at once: proof the tests interleaved. */
  readonly peak: number
}> {
  const random = seeded(seed)
  const plan = Array.from({ length: count }, (_, i) => ({
    name: `test ${i}`,
    n: 1 + Math.floor(random() * 5),
    pauses: Array.from({ length: 5 }, () => Math.floor(random() * 4)),
  }))
  const counted: Counted[] = []
  let active = 0
  let peak = 0
  await runRegistered(
    (api) => {
      for (const { name, n, pauses } of plan) {
        let step = 0
        const pause = async (): Promise<void> => {
          for (let k = 0; k < (pauses[step % pauses.length] ?? 0); k++) {
            await new Promise((resolve) => setImmediate(resolve))
          }
          step++
        }
        api.test.concurrent(name, async () => {
          peak = Math.max(peak, ++active)
          counted.push({ n, ...(await body(n, pause)) })
          active--
        })
      }
    },
    { ...neutralPolicy.core, maxConcurrency: count },
  )
  return { counted, peak }
}

/** The worker's boot order (U1): state source, slot, table, then `expect`. */
export interface JestExpectSetup {
  readonly expect: ExpectStatic
  readonly source: StateSource
}

/**
 * Installs the slot and builds the Jest dialect's `expect`, in the order the worker must use. The
 * slot is uninstalled when the test `t` ends.
 */
export function setUpJestExpect(t: TestContext): JestExpectSetup {
  const source = createStateSource(currentTest, {
    nameSeparator: neutralPolicy.core.nameSeparator,
    expand: jestExpectPolicy.expand,
  })
  const registry = createMatcherRegistry()
  const slot = installMatchersSlot(source, registry)
  t.after(() => slot.uninstall())
  const expect = createExpect({
    policy: jestExpectPolicy,
    table: jestExpectTable(),
    source,
    registry,
  })
  return { expect, source }
}

/** A stand-in for an environment global: the real timers on an object a clock can fake. */
export function standInGlobal(warnings: string[] = []): typeof globalThis {
  return {
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
  } as unknown as typeof globalThis
}

/**
 * The two host members the timer members read: a clock on a stand-in global (so a test never
 * fakes the timers the test runner runs on) and the Jest timers policy.
 */
export function timerHost(
  global: typeof globalThis = standInGlobal(),
  options: FakeClockOptions = {},
): {
  timers: () => FakeClock
  timersPolicy: TimersPolicy
  seed: number
  environmentTornDown: () => boolean
  setDefaultTimeout: (ms: number | undefined) => void
} {
  const timersPolicy = resolvePolicy(jestPolicy).timers
  const clock = createFakeClock(global, timersPolicy, options)
  return {
    timers: () => clock,
    timersPolicy,
    seed: 0,
    environmentTornDown: () => false,
    setDefaultTimeout: () => {},
  }
}
