// Runs one mocking-corpus test file through `@provino/core` with `jest` or `vi` built from
// `@provino/mock` under a profile's `MockPolicy` (B13a's corpus check, T4.3, T4.4). The recorder's
// real `observe-setup` and a `trace` global reduce and record each case, so both sides of the
// comparison run the same reduction. A root `beforeEach` runs the registry's between-test cleanup,
// as a real run will once T4.10 wires it (B13a Gap 9).
import { pathToFileURL } from 'node:url'
import { createRuntime } from '@provino/core'
import {
  createMockFn,
  createMockRegistry,
  createStubs,
  isMockFunction,
  type Mock,
  type MockRegistry,
  replaceProperty,
  type Stubs,
  spyOn,
  type UnknownFunction,
} from '@provino/mock'
import { createBehaviourLoader } from '@provino/policy'
import type { CorePolicy, MockPolicy } from '@provino/types'
import type { MockCleanup } from '../fixture.ts'
import { installGlobals } from '../internal/globals.ts'
import '../internal/observe-setup.ts'

/** Which test-object name the file under test sees. */
export type MockFacade = 'jest' | 'vi'

type Loose = (...args: never[]) => unknown

/**
 * The part of the `jest` / `vi` object the corpus uses, built over one registry. The corpus files
 * pass arbitrary values, so the methods are loosely typed here; the engine's own types are covered
 * by `@provino/mock`'s type tests.
 */
function createFacade(
  facade: MockFacade,
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
  }
  if (facade === 'jest') {
    object.replaceProperty = (target: object, key: string, value: unknown): unknown =>
      replaceProperty(policy, registry, target as Record<string, unknown>, key, value)
  } else {
    object.stubEnv = (name: string, value: string | undefined): unknown => {
      stubs.stubEnv(name, value)
      return object
    }
    object.stubGlobal = (name: string, value: unknown): unknown => {
      stubs.stubGlobal(name, value)
      return object
    }
    object.unstubAllEnvs = (): unknown => {
      stubs.unstubAllEnvs()
      return object
    }
    object.unstubAllGlobals = (): unknown => {
      stubs.unstubAllGlobals()
      return object
    }
  }
  return object
}

let imports = 0

/**
 * Runs `file` (absolute) under `corePolicy` with `jest` or `vi` over a fresh registry built with
 * `mockPolicy`, and returns the lines `observe` traced, in order. `cleanup` is the fixture's
 * `mockCleanup`. The registry is disposed afterwards, as the worker will.
 */
export async function runMockFile(
  file: string,
  rootDir: string,
  corePolicy: CorePolicy,
  mockPolicy: MockPolicy,
  facade: MockFacade,
  cleanup: MockCleanup,
): Promise<readonly string[]> {
  const lines: string[] = []
  const registry = createMockRegistry()
  const stubs = createStubs(registry, process.env, globalThis)
  const runtime = await createRuntime({
    policy: corePolicy,
    behaviours: createBehaviourLoader(),
    sink: { emit: () => undefined },
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
  const restore = installGlobals({
    trace: (step: string): void => {
      lines.push(step)
    },
    ...runtime.api,
    [facade]: createFacade(facade, mockPolicy, registry, stubs),
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
  return lines
}
