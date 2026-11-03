// Test helpers (not a test file): spike E's interleaved tests (Track 7 §Spikes E), run through
// core's real runtime so `test.concurrent` and the current-test lookup are the worker's own.
import { createRuntime, currentTest } from '@provino/core'
import {
  createExpect,
  createMatcherRegistry,
  createStateSource,
  installMatchersSlot,
  type MatcherRegistry,
  type SlotHandle,
  type StateSource,
} from '@provino/expect'
import { createBehaviourLoader, neutralPolicy } from '@provino/policy'
import type { ExpectStatic, RuntimeEvent } from '@provino/types'
import { jestExpectPolicy } from '../../expect-policy.ts'
import { jestExpectTable } from '../expect-table.ts'

/** What one test counted, read inside the test as it ends. */
export interface Counted {
  readonly name: string
  /** The `n` it passed to `expect.assertions(n)` and then asserted `n` times. */
  readonly n: number
  readonly assertionCalls: number
  readonly expectedAssertionsNumber: number | null
}

/** A test body: `expect.assertions(n)`, then `n` assertions with `pause()`s between them. */
export type CountingBody = (
  n: number,
  pause: () => Promise<void>,
) => Promise<Omit<Counted, 'name' | 'n'>>

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
 * Runs `count` `test.concurrent` tests at once through core's runtime. Test `i` asserts
 * `n` = 1–5 times (seeded), yielding 0–3 macrotasks (seeded) before each assertion, so the tests
 * interleave with no real-time wait. Returns what each counted, the runtime's events, and how
 * many bodies ran at once.
 */
export async function runInterleaved(
  count: number,
  seed: number,
  body: CountingBody,
): Promise<{
  readonly counted: readonly Counted[]
  readonly events: readonly RuntimeEvent[]
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
  const events: RuntimeEvent[] = []
  let active = 0
  let peak = 0
  const runtime = await createRuntime({
    policy: { ...neutralPolicy.core, maxConcurrency: count },
    behaviours: createBehaviourLoader(),
    sink: { emit: (event) => events.push(event) },
    importFile: async () => {
      for (const { name, n, pauses } of plan) {
        let step = 0
        const pause = async (): Promise<void> => {
          for (let k = 0; k < (pauses[step % pauses.length] ?? 0); k++) {
            await new Promise((resolve) => setImmediate(resolve))
          }
          step++
        }
        runtime.api.test.concurrent(name, async () => {
          peak = Math.max(peak, ++active)
          counted.push({ name, n, ...(await body(n, pause)) })
          active--
        })
      }
    },
    rootDir: '/spike-e',
  })
  try {
    await runtime.runFile('/spike-e/interleaved.test.ts')
  } finally {
    await runtime.dispose()
  }
  return { counted, events, peak }
}

/** The worker's boot order (U1): state source, slot, table, then `expect`. */
export interface JestExpectSetup {
  readonly expect: ExpectStatic
  readonly source: StateSource
  readonly registry: MatcherRegistry
  readonly slot: SlotHandle
}

/** Installs the slot and builds the Jest dialect's `expect`, in the order the worker must use. */
export function setUpJestExpect(): JestExpectSetup {
  const source = createStateSource(currentTest, {
    nameSeparator: neutralPolicy.core.nameSeparator,
    expand: jestExpectPolicy.expand,
  })
  const registry = createMatcherRegistry()
  const slot = installMatchersSlot(source, registry)
  const expect = createExpect({
    policy: jestExpectPolicy,
    table: jestExpectTable(),
    source,
    registry,
  })
  return { expect, source, registry, slot }
}
