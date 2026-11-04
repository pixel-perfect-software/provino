// The Jest dialect's globals (T1.8's globals half; the rest of the `jest` object is T11.10/B13).
// The worker builds them once per worker from its own runtime: core's API, `expect`, and the
// registry of the file running now. Nothing here is module-level state.
import type { RuntimeApi, SuiteApi, TestApi } from '@provino/core'
import type { createExpect } from '@provino/expect'
import type { GlobalsHost } from '@provino/types'

/**
 * What `jestGlobals` builds the globals from: `GlobalsHost` with the real types of the two
 * objects it declares as `object`. `GlobalsFactory` is bivariant in the host, so `jestGlobals`
 * is still a `GlobalsFactory`; through that type it accepts any host, so the worker must pass
 * the one it declares here.
 * @public
 */
export interface JestGlobalsHost extends GlobalsHost {
  /** Core's global API: `runtime.api`. */
  readonly api: RuntimeApi
  /** The worker's `expect`, from `createExpect`. */
  readonly expect: ReturnType<typeof createExpect>
}

/**
 * The `jest` global, as far as the worker runtime goes: the module registry methods, which act on
 * the registry of the file running when they are called. Mocks, timers, `setTimeout`,
 * `retryTimes` and the rest of Jest's `jest` object are not here yet (T11.10 and B13).
 * @public
 */
export interface JestObject {
  /** Runs `fn` in an isolated module registry, then returns `jest`. */
  isolateModules(fn: () => void): JestObject
  /** Runs `fn` in an isolated module registry; resolves with nothing when `fn` has settled. */
  isolateModulesAsync(fn: () => Promise<void>): Promise<void>
  /** Forgets every module loaded so far in the file, then returns `jest`. */
  resetModules(): JestObject
}

/**
 * The globals Jest 30.5 injects into a test file, exactly: `jestDialect.globals.names` lists
 * these keys. A type alias, not an interface, so it is a `Readonly<Record<string, unknown>>`
 * like a `GlobalsFactory`'s result.
 * @public
 */
export type JestGlobals = {
  readonly afterAll: RuntimeApi['afterAll']
  readonly afterEach: RuntimeApi['afterEach']
  readonly beforeAll: RuntimeApi['beforeAll']
  readonly beforeEach: RuntimeApi['beforeEach']
  readonly describe: SuiteApi
  readonly expect: ReturnType<typeof createExpect>
  /** `describe.only`. */
  readonly fdescribe: SuiteApi
  /** `it.only`. */
  readonly fit: TestApi
  readonly it: TestApi
  readonly jest: JestObject
  readonly test: TestApi
  /** `describe.skip`. */
  readonly xdescribe: SuiteApi
  /** `it.skip`. */
  readonly xit: TestApi
  /** `test.skip`. */
  readonly xtest: TestApi
}

/**
 * Builds Jest 30.5's injected globals. `describe`, `it`, `test` and the four hooks are core's;
 * the `f` and `x` forms are core's `only` and `skip` modifiers; `expect` is the worker's. Each
 * call returns new objects, and the worker installs them on the environment's global.
 *
 * The `jest` object has `isolateModules`, `isolateModulesAsync` and `resetModules`, nothing else.
 * Each reads `host.registry()` when it is called, because every file has its own registry.
 * @public
 */
export function jestGlobals(host: JestGlobalsHost): JestGlobals {
  const { api, expect } = host
  const jest: JestObject = {
    isolateModules(fn) {
      host.registry().isolateModules(fn)
      // unverified: jest-runtime 30.5.2 `JestGlobals.ts` L267-L270 returns `jestObject`; read from source, not recorded
      return jest
    },
    async isolateModulesAsync(fn) {
      // unverified: jest-runtime 30.5.2 `JestGlobals.ts` L271 hands back the runtime's `Promise<void>`; read from source, not recorded
      await host.registry().isolateModulesAsync(fn)
    },
    resetModules() {
      host.registry().resetModules()
      // unverified: jest-runtime 30.5.2 `JestGlobals.ts` L263-L266 returns `jestObject`; read from source, not recorded
      return jest
    },
  }
  return {
    afterAll: api.afterAll,
    afterEach: api.afterEach,
    beforeAll: api.beforeAll,
    beforeEach: api.beforeEach,
    describe: api.describe,
    expect,
    fdescribe: api.describe.only,
    fit: api.it.only,
    it: api.it,
    jest,
    test: api.test,
    xdescribe: api.describe.skip,
    xit: api.it.skip,
    xtest: api.test.skip,
  }
}
