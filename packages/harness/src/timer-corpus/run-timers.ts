// Runs one timer-corpus test file through `@provino/core` with `jest` or `vi` over a fake clock on
// the real global (B17a, T4.9). It fakes this process's own timers, so it runs only in the child
// process `child.ts` starts: never in the harness's test process. Under `jest` the object is the
// one `jestGlobals` ships, over a host whose `timers()` is the clock, so a bug in its wiring shows
// here; under `vi` it is the one `vitestGlobals` ships (B25f), over the same host.
import { pathToFileURL } from 'node:url'
import { createRuntime, currentTest } from '@provino/core'
import { jestGlobals } from '@provino/dialect-jest/runtime'
import { vitestGlobals } from '@provino/dialect-vitest/runtime'
import { createMockRegistry } from '@provino/mock'
import { createBehaviourLoader } from '@provino/policy'
import { createFakeClock } from '@provino/timers'
import type { CorePolicy, MockPolicy, RuntimeEvent, TimersPolicy } from '@provino/types'
import { installGlobals } from '../internal/globals.ts'
import '../internal/observe-setup.ts'
import { unusedJestHost } from '../internal/unused-jest-host.ts'
import { type CoreRun, summarizeRun } from '../runtime-corpus/run-core.ts'

/** Which test-object name the file under test sees. */
export type TimerFacade = 'jest' | 'vi'

let imports = 0

/**
 * Runs `file` (absolute) under `corePolicy` with the fake clock built from `timersPolicy` on this
 * process's global, each callback bound to the test that scheduled it. The clock is uninstalled
 * afterwards, as the worker will. Returns what core reported (`trace` holds the `observe` lines).
 */
export async function runTimerFile(
  file: string,
  rootDir: string,
  corePolicy: CorePolicy,
  mockPolicy: MockPolicy,
  timersPolicy: TimersPolicy,
  facade: TimerFacade,
): Promise<CoreRun> {
  const lines: string[] = []
  const events: RuntimeEvent[] = []
  const clock = createFakeClock(globalThis, timersPolicy, { bind: currentTest.bind })
  const runtime = await createRuntime({
    policy: corePolicy,
    behaviours: createBehaviourLoader(),
    sink: { emit: (event) => events.push(event) },
    importFile: (path) => import(`${pathToFileURL(path).href}?timer-run=${++imports}`),
    rootDir,
    ci: true,
  })
  const object =
    facade === 'jest'
      ? jestGlobals(
          unusedJestHost(runtime.api, createMockRegistry(), mockPolicy, 'the timer corpus', {
            clock: () => clock,
            policy: timersPolicy,
          }),
        ).jest
      : vitestGlobals(
          unusedJestHost(runtime.api, createMockRegistry(), mockPolicy, 'the timer corpus', {
            clock: () => clock,
            policy: timersPolicy,
          }),
        ).vi
  const restore = installGlobals({
    trace: (step: string): void => {
      lines.push(step)
    },
    ...runtime.api,
    [facade]: object,
  })
  try {
    await runtime.runFile(file)
  } finally {
    try {
      clock.dispose()
    } finally {
      restore()
      await runtime.dispose()
    }
  }
  return summarizeRun(events, lines)
}
