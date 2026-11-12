// A tiny globals factory for the runtime tests: the test API from the host, plus two probes. The
// orchestrator may not depend on a dialect, so this stands in for the dialect's factory.
import type { GlobalsHost } from '@provino/types'
import { slotMatchers, trace } from './runtime-env.ts'

/** The ids `probeMocks` gave the mock registries it has seen (also: which it already wrapped). */
const mockIds = new WeakMap<object, number>()
let nextMockId = 1

type Probe = {
  [name: string]: unknown
}

export function testGlobals(host: GlobalsHost): Probe {
  trace('globals:factory')
  const api = host.api as Record<string, unknown>
  return {
    describe: api.describe,
    it: api.it,
    test: api.test,
    beforeAll: api.beforeAll,
    afterAll: api.afterAll,
    beforeEach: api.beforeEach,
    afterEach: api.afterEach,
    expect: host.expect,
    /** The run's seed, as the host has it (`jest.getSeed()` in the Jest dialect). */
    getSeed: () => host.seed,
    /** The path of the file whose registry the host serves now. */
    currentRegistryFile: () => host.registry().file,
    /**
     * Makes the running file's registry report its `dispose` (with the matchers the slot holds
     * then) to the trace, so a test can see when the worker disposes it.
     */
    probeRegistry: () => {
      const registry = host.registry()
      const dispose = registry.dispose.bind(registry)
      registry.dispose = () => {
        trace(`registry:dispose matchers=${slotMatchers()}`)
        return dispose()
      }
    },
    /**
     * Traces which mock registry the running file has (`mocks:registry <n>`, the same n for the
     * same registry) and, once per registry, when it is disposed. `probeMocks(true)` makes that
     * `dispose` throw after tracing, so a test can see the rest of the teardown still run.
     */
    probeMocks: (throws = false) => {
      const mocks = host.mocks() as { dispose(): void }
      const known = mockIds.has(mocks)
      if (!known) mockIds.set(mocks, nextMockId++)
      trace(`mocks:registry ${mockIds.get(mocks)}`)
      if (known) return
      const dispose = mocks.dispose.bind(mocks)
      mocks.dispose = () => {
        trace(`mocks:dispose ${mockIds.get(mocks)}`)
        dispose()
        if (throws) throw new Error('mock dispose failed')
      }
    },
    /** The mock policy the host carries, as its `defaultName`: a probe that it arrived. */
    mockPolicyName: () => host.mockPolicy.defaultName,
  }
}

/**
 * `testGlobals`, and the factory itself adds a matcher to `expect` once, the way a dialect's
 * factory may. The worker must treat that matcher as part of the baseline it restores to after
 * each file.
 */
export function extendingGlobals(host: GlobalsHost): Probe {
  const globals = testGlobals(host)
  const expectWithExtend = host.expect as {
    extend(matchers: Record<string, (received: unknown) => unknown>): void
  }
  expectWithExtend.extend({
    toBeFromFactory: (received) => ({
      pass: received === 'factory',
      message: () => `expected ${String(received)} to be "factory"`,
    }),
  })
  return globals
}
