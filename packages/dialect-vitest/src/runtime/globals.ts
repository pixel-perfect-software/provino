// The Vitest dialect's globals and served modules (T11.16's facade, U9's Vitest half, B25f). The
// worker builds them once per worker from its own runtime: core's API, `expect`, and the
// registries of the file running now, which `vi` reads when it is called.
import type { RuntimeApi, SuiteApi, TestApi } from '@provino/core'
import { populateGlobal } from '@provino/env-shared'
import type { createExpect } from '@provino/expect'
import { VitestDialectError } from '../internal/dialect-error.ts'
import { chaiWithVitestPlugins } from './expect/assertion.ts'
import { expectTypeOf } from './expect-type-of.ts'
import {
  createVi,
  createViShared,
  type ViShared,
  type VitestGlobalsHost,
  type VitestObject,
} from './vi.ts'

/**
 * The globals Vitest 5.0 injects with `globals: true` (`globalApis`), exactly: `vitestDialect.globals.names`
 * lists these keys.
 * @public
 */
export type VitestGlobals = {
  readonly afterAll: RuntimeApi['afterAll']
  readonly afterEach: RuntimeApi['afterEach']
  readonly aroundAll: RuntimeApi['aroundAll']
  readonly aroundEach: RuntimeApi['aroundEach']
  /** Chai's `assert`, loaded on first use. */
  readonly assert: (...args: readonly unknown[]) => void
  /** A no-op at run time: `vitest --typecheck` reads it. */
  readonly assertType: (value: unknown) => void
  readonly beforeAll: RuntimeApi['beforeAll']
  readonly beforeEach: RuntimeApi['beforeEach']
  /** Chai with Vitest's plugins, loaded on first use. */
  readonly chai: object
  readonly describe: SuiteApi
  readonly expect: ReturnType<typeof createExpect>
  /** `expect-type`'s `expectTypeOf` at run time: every check passes. */
  readonly expectTypeOf: typeof expectTypeOf
  readonly it: TestApi
  readonly onTestFailed: RuntimeApi['onTestFailed']
  readonly onTestFinished: RuntimeApi['onTestFinished']
  readonly suite: SuiteApi
  readonly test: TestApi
  readonly vi: VitestObject
  /** `vi`. */
  readonly vitest: VitestObject
}

/** What one host's globals and module scope share. */
interface Built {
  readonly shared: ViShared
  readonly globals: VitestGlobals
}

const builtByHost = new WeakMap<VitestGlobalsHost, Built>()

/**
 * A stand-in that loads Chai only when it is used: the worker copies every global's value as it
 * installs them, so a getter would load Chai at boot. A function target, so `assert(x)` calls.
 */
function lazyChaiValue<T extends object>(read: () => T, name: string): T {
  const target = Object.defineProperty(() => {}, 'name', { value: name })
  return new Proxy(target, {
    apply: (_target, thisArg, args) => Reflect.apply(read() as never, thisArg, args),
    get: (_target, key) => Reflect.get(read(), key),
    has: (_target, key) => Reflect.has(read(), key),
    set: (_target, key, value) => Reflect.set(read(), key, value),
    ownKeys: () => Reflect.ownKeys(read()),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(read(), key)
      return descriptor === undefined ? undefined : { ...descriptor, configurable: true }
    },
  }) as unknown as T
}

function built(host: VitestGlobalsHost): Built {
  const known = builtByHost.get(host)
  if (known !== undefined) return known
  const { api } = host
  const shared = createViShared(host)
  const vi = createVi(shared, null)
  const chai = lazyChaiValue(() => chaiWithVitestPlugins(), 'chai')
  const assert = lazyChaiValue(
    () => Reflect.get(chaiWithVitestPlugins(), 'assert') as (...args: readonly unknown[]) => void,
    'assert',
  )
  const globals: VitestGlobals = {
    afterAll: api.afterAll,
    afterEach: api.afterEach,
    aroundAll: api.aroundAll,
    aroundEach: api.aroundEach,
    assert,
    // `typecheck/assertType.ts`: `function assertType() {}`.
    assertType: function assertType(): void {},
    beforeAll: api.beforeAll,
    beforeEach: api.beforeEach,
    chai,
    describe: api.describe,
    expect: host.expect,
    expectTypeOf,
    it: api.it,
    onTestFailed: api.onTestFailed,
    onTestFinished: api.onTestFinished,
    suite: api.suite,
    test: api.test,
    vi,
    vitest: vi,
  }
  const made = { shared, globals }
  builtByHost.set(host, made)
  return made
}

/**
 * Builds Vitest 5.0's injected globals (`globals: true`): core's suite, test and hook API, the
 * worker's `expect`, Chai and its `assert` (loaded when first used), the type-test functions
 * (no-ops at run time) and `vi`. One set per host: the `vitest` module `vitestModuleScope`
 * serves holds the same objects.
 * @public
 */
export function vitestGlobals(host: VitestGlobalsHost): VitestGlobals {
  return built(host).globals
}

/** `inject` and `recordArtifact`: exported so a file that imports them loads; refused when called. */
function notBuilt(name: string): () => never {
  return () => {
    throw new VitestDialectError(
      'VITEST_DIALECT_NOT_BUILT',
      `\`${name}\` from 'vitest' is not supported by Provino yet`,
    )
  }
}

/**
 * The Vitest dialect's per-module bindings (`vitestDialect.moduleScope`): each module whose source
 * names `vi` gets its own `vi`, which knows the module (`vi.mock` resolves from it),
 * and an import of `vitest`, `@vitest/expect`, `@vitest/spy` or `vitest/runtime` is answered here.
 * Called once per worker.
 * @public
 */
export function vitestModuleScope(
  host: VitestGlobalsHost,
): (from: string) => Readonly<Record<string, unknown>> {
  const objects = new Map<string, VitestObject>()
  return (from) => {
    let vi = objects.get(from)
    if (vi === undefined) {
      vi = createVi(built(host).shared, from)
      objects.set(from, vi)
    }
    const own = vi
    const scope: Record<string, unknown> = { vi: own }
    // Lazy and not enumerable: the keys of the result stay the binding names.
    const served = (name: string, get: () => unknown): void => {
      Object.defineProperty(scope, name, { get, enumerable: false })
    }
    served('vitest', () => {
      const globals = vitestGlobals(host)
      return {
        ...globals,
        vi: own,
        vitest: own,
        // `integrations/chai/index.ts`: Chai's `should`, installed on first call.
        should: () =>
          Reflect.apply(
            Reflect.get(chaiWithVitestPlugins(), 'should') as () => unknown,
            undefined,
            [],
          ),
        inject: notBuilt('inject'),
        recordArtifact: notBuilt('recordArtifact'),
      }
    })
    served('@vitest/spy', () => ({
      fn: own.fn,
      spyOn: own.spyOn,
      isMockFunction: own.isMockFunction,
      clearAllMocks: () => void own.clearAllMocks(),
      resetAllMocks: () => void own.resetAllMocks(),
      restoreAllMocks: () => void own.restoreAllMocks(),
    }))
    served('@vitest/expect', () => ({ expect: host.expect }))
    served('vitest/runtime', () => ({ populateGlobal }))
    return scope
  }
}
