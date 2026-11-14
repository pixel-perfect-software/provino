// The host `jestGlobals` is given by the corpora that run a file through `@provino/core` without a
// worker. It lives here, not in `mock-corpus/run-mock.ts`, because the runtime corpus needs it too
// and `run-mock.ts` reads the runtime corpus (a cycle) and installs the observe globals when loaded.
import type { JestGlobalsHost } from '@provino/dialect-jest/runtime'
import type { MockRegistry } from '@provino/mock'
import { neutralPolicy } from '@provino/policy'
import type { FakeClock } from '@provino/timers'
import type { MockPolicy, TimersPolicy } from '@provino/types'

/**
 * The host `jestGlobals` is given by the corpora that run a file over `@provino/mock` alone: its
 * `mocks()` is the file's registry, and `expect` and the module registry throw, because the
 * fixtures of these corpora use neither (`timers`, when given, is the clock the timer members act on). `label` names the corpus in that error.
 */
export function unusedJestHost(
  api: JestGlobalsHost['api'],
  mocks: MockRegistry,
  mockPolicy: MockPolicy,
  label: string,
  timers?: { readonly clock: () => FakeClock; readonly policy: TimersPolicy },
): JestGlobalsHost {
  return {
    api,
    expect: (() => {
      throw new Error(`${label} does not use expect`)
    }) as unknown as JestGlobalsHost['expect'],
    registry: () => {
      throw new Error(`${label} does not use the module registry`)
    },
    mocks: () => mocks,
    moduleMocks: () => {
      throw new Error(`${label} does not use the module-mock registry`)
    },
    mockPolicy,
    timers:
      timers?.clock ??
      ((): never => {
        throw new Error(`${label} does not use the fake clock`)
      }),
    timersPolicy: timers?.policy ?? neutralPolicy.timers,
    seed: 0,
    environmentTornDown: () => false,
    setDefaultTimeout: () => {},
    setDefaultRetry: () => {},
    setDescribeRetry: () => 'set',
  }
}
