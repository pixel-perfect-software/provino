// Runs one mocking-corpus test file through `@provino/core` with `jest` or `vi` over a
// `@provino/mock` registry under a profile's `MockPolicy` (B13a's corpus check, T4.3, T4.4). The
// recorder's real `observe-setup` and a `trace` global reduce and record each case, so both sides of
// the comparison run the same reduction. A root `beforeEach` runs the registry's between-test
// cleanup, as a real run will once T4.10 wires it (B13a Gap 9). What core reports for each test is
// returned too, so a test that fails inside the fixture (outside `observe`) is seen.
import { pathToFileURL } from 'node:url'
import { createRuntime } from '@provino/core'
import { type JestGlobalsHost, jestGlobals } from '@provino/dialect-jest/runtime'
import {
  createMockFn,
  createMockRegistry,
  createStubs,
  isMockFunction,
  type Mock,
  type MockRegistry,
  type Stubs,
  spyOn,
  type UnknownFunction,
} from '@provino/mock'
import { createBehaviourLoader } from '@provino/policy'
import type { CorePolicy, MockPolicy, RuntimeEvent } from '@provino/types'
import type { MockCleanup } from '../fixture.ts'
import { installGlobals } from '../internal/globals.ts'
import '../internal/observe-setup.ts'
import { type CoreRun, summarizeRun } from '../runtime-corpus/run-core.ts'

/** Which test-object name the file under test sees. */
export type MockFacade = 'jest' | 'vi'

type Loose = (...args: never[]) => unknown

/**
 * The part of the `vi` object the corpus uses, built over one registry. It stays here until
 * `@provino/dialect-vitest` ships its own (T1.8, B14a). The corpus files pass arbitrary values, so
 * the methods are loosely typed; the engine's own types are covered by `@provino/mock`'s type
 * tests.
 */
export function createViFacade(
  policy: MockPolicy,
  registry: MockRegistry,
  stubs: Stubs,
): Record<string, unknown> {
  const object: Record<string, unknown> = {
    fn: (impl?: UnknownFunction): Mock =>
      impl === undefined
        ? createMockFn(policy, registry)
        : createMockFn(policy, registry, { impl }),
    spyOn: (target: object, key: string, access?: 'get' | 'set'): unknown =>
      spyOn(policy, registry, target as Record<string, Loose>, key, access as never),
    isMockFunction: (value: unknown): boolean => isMockFunction(policy, value),
    clearAllMocks: (): unknown => {
      registry.clearAll()
      return object
    },
    resetAllMocks: (): unknown => {
      registry.resetAll()
      return object
    },
    restoreAllMocks: (): unknown => {
      registry.restoreAll()
      return object
    },
    stubEnv: (name: string, value: string | undefined): unknown => {
      stubs.stubEnv(name, value)
      return object
    },
    stubGlobal: (name: string, value: unknown): unknown => {
      stubs.stubGlobal(name, value)
      return object
    },
    unstubAllEnvs: (): unknown => {
      stubs.unstubAllEnvs()
      return object
    },
    unstubAllGlobals: (): unknown => {
      stubs.unstubAllGlobals()
      return object
    },
  }
  return object
}

/**
 * The host `jestGlobals` is given by the corpora that run a file over `@provino/mock` alone: its
 * `mocks()` is the file's registry, and `expect` and the module registry throw, because the
 * fixtures of these corpora use neither. `label` names the corpus in that error.
 */
export function unusedJestHost(
  api: JestGlobalsHost['api'],
  mocks: MockRegistry,
  mockPolicy: MockPolicy,
  label: string,
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
    mockPolicy,
  }
}

let imports = 0

/**
 * Runs `file` (absolute) under `corePolicy` with `jest` or `vi` over a fresh registry built with
 * `mockPolicy`. Under `jest` the object is the one `jestGlobals` ships, over a host whose `mocks()`
 * is this file's registry, so a bug in its wiring shows here. `cleanup` is the fixture's
 * `mockCleanup`. The registry is disposed afterwards, as the worker will. Returns what core
 * reported (`trace` holds the `observe` lines, in order).
 */
export async function runMockFile(
  file: string,
  rootDir: string,
  corePolicy: CorePolicy,
  mockPolicy: MockPolicy,
  facade: MockFacade,
  cleanup: MockCleanup,
): Promise<CoreRun> {
  const lines: string[] = []
  const events: RuntimeEvent[] = []
  const registry = createMockRegistry()
  const stubs = createStubs(registry, process.env, globalThis)
  const runtime = await createRuntime({
    policy: corePolicy,
    behaviours: createBehaviourLoader(),
    sink: { emit: (event) => events.push(event) },
    importFile: (path) => {
      // Before the file's own hooks, so the cleanup runs first in every test.
      runtime.api.beforeEach(() => {
        registry.beforeEach(cleanup, mockPolicy.between)
      })
      return import(`${pathToFileURL(path).href}?mock-run=${++imports}`)
    },
    rootDir,
    ci: true,
  })
  let object: unknown
  if (facade === 'jest') {
    object = jestGlobals(
      unusedJestHost(runtime.api, registry, mockPolicy, 'the mocking corpus'),
    ).jest
  } else {
    object = createViFacade(mockPolicy, registry, stubs)
  }
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
      registry.dispose()
    } finally {
      restore()
      await runtime.dispose()
    }
  }
  return summarizeRun(events, lines)
}
