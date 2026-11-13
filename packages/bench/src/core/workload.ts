// The core overhead workload (T5.14), rebuilt from Track 5's deleted `collector/bench-core.ts`
// (10,000 empty tests, 3 hooks, 8 events per test). One file registers `tests` empty tests under
// three hooks that run around every test (two `beforeEach`, one `afterEach`), and the real runtime
// collects and runs it: registration, the tree, every attempt in its own AsyncLocalStorage store,
// the hooks, the test context and every event, into a sink that only counts them. The spike's
// "8 events per test" were a test's start and end plus a start and an end per hook; core's own
// event set adds an attempt's start and end, so it is 10 here. Shared by `pnpm bench:core` (wall
// time per test) and the `core` leg of `provino-bench instructions` (instruction counts).
import { createRuntime } from '@provino/core'
import { jestPolicy } from '@provino/dialect-jest'
import { createBehaviourLoader, resolvePolicy } from '@provino/policy'
import type { CorePolicy } from '@provino/types'

/**
 * Tests in the workload's one file.
 * @public
 */
export const CORE_TESTS = 10_000

/**
 * Hooks that run around every test.
 * @public
 */
export const CORE_HOOKS_PER_TEST = 3

/**
 * Whether the runtime captures task and hook locations. `on` is how the worker runs it (the
 * runtime's default); `off` is the spike's "locations off" column.
 * @public
 */
export type CoreLocations = 'on' | 'off'

/**
 * What one pass found.
 * @public
 */
export interface CorePass {
  /** Tests that passed: the workload is correct only when this is `tests`. */
  readonly passed: number
  /** Events the sink saw. */
  readonly events: number
  /** Wall time of `runFile`, ms (`local`). */
  readonly elapsedMs: number
}

const POLICY: CorePolicy = resolvePolicy(jestPolicy).core

/**
 * Collects and runs one file of `tests` empty tests with three per-test hooks, under the Jest
 * dialect's core policy, as the worker would. A fresh runtime per pass.
 * @public
 */
export async function runCorePass(
  locations: CoreLocations,
  tests: number = CORE_TESTS,
): Promise<CorePass> {
  let events = 0
  let passed = 0
  const runtime = await createRuntime({
    policy: POLICY,
    behaviours: createBehaviourLoader(),
    sink: {
      emit: (event) => {
        events++
        if (event.type === 'test-end' && event.result.state === 'pass') passed++
      },
    },
    importFile: async () => {
      const { beforeEach, afterEach, test } = runtime.api
      beforeEach(() => {})
      beforeEach(() => {})
      afterEach(() => {})
      for (let i = 0; i < tests; i++) test(`test ${i}`, () => {})
    },
    rootDir: '/bench',
    locations: locations === 'on',
  })
  const start = performance.now()
  await runtime.runFile('/bench/core.test.ts')
  const elapsedMs = performance.now() - start
  await runtime.dispose()
  return { passed, events, elapsedMs }
}
