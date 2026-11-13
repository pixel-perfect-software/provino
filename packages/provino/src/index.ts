// `provino`: what a test file imports. Phase 1 form (T1.10): the Jest dialect's test-definition
// API, `describe`, `it`, `test`, the hooks and `expect`, bound late to the globals the worker
// installs (`injectGlobals`, which is on unless a project turns it off), and the lazy variables
// (`lazy`, the shared examples), which are neutral and never globals: they read the runtime the
// worker puts in a `Symbol.for` slot, so they work with `injectGlobals` off. `fn`, `spyOn`, `mock`
// and `timers` of Track 1's table arrive with the neutral API; today they are `jest.fn`,
// `jest.spyOn`, `jest.mock` and `jest.useFakeTimers`, on the Jest facade.
//
// This file imports only the lazy forwarders at run time (a few small functions that read the slot
// when called). The worker's engine is in its own chunks, which a test
// file reaching `provino` must not load a second time: a copy of `expect` here would have its own
// matchers and its own state, not the test's.
import type { JestGlobals } from '@provino/dialect-jest/runtime'

export {
  evaluatedLazies,
  includeContext,
  includeExamples,
  itBehavesLike,
  type Lazy,
  LazyError,
  type LazyErrorCode,
  lazy,
  sharedContext,
  sharedExamples,
} from '@provino/lazy'

/**
 * What the `provino` entry exports: the Jest dialect's test-definition globals, typed as the
 * dialect builds them.
 * @public
 */
export type WorkerApi = Pick<
  JestGlobals,
  'afterAll' | 'afterEach' | 'beforeAll' | 'beforeEach' | 'describe' | 'expect' | 'it' | 'test'
>

/**
 * Thrown by every `provino` export used where no worker has installed it: outside a test file
 * Provino is running, or in a project with `injectGlobals` off.
 * @public
 */
export class ProvinoWorkerApiError extends Error {
  readonly code = 'PROVINO_NO_WORKER_API'

  constructor(name: string) {
    super(
      `provino: "${name}" is only available inside a test file that Provino is running, with the Jest globals injected (injectGlobals is on by default).`,
    )
    this.name = 'ProvinoWorkerApiError'
  }
}

/** The live value of a global the worker installed, or the error that says there is none. */
function live(name: string): object {
  const value: unknown = Reflect.get(globalThis, name)
  if ((typeof value === 'function' || typeof value === 'object') && value !== null) return value
  throw new ProvinoWorkerApiError(name)
}

/**
 * A stand-in for the global `name` that forwards every operation to it when the operation happens,
 * so `expect.extend`, `describe.each` and `it.only` need no list of statics.
 *
 * The target is a bound class: callable by a trap and constructible (an arrow function is not, so
 * its `construct` trap could never run; `function () {}` would be, but has a non-configurable
 * `prototype`, and Biome rewrites it to an arrow) and with no `prototype`, so every own key it has
 * (`length`, `name`) is configurable and the proxy may report any keys the live value has. It
 * stays extensible (`preventExtensions` is refused) and holds no property of its own that is not
 * configurable (a non-configurable define is refused), which is what lets the traps answer for the
 * live value and still satisfy the invariants a Proxy checks.
 */
function bound<K extends keyof WorkerApi>(name: K): WorkerApi[K] {
  const target: object = class {}.bind(null)
  const proxy = new Proxy(target, {
    apply: (_target, thisArg, args: unknown[]) =>
      Reflect.apply(live(name) as (...args: unknown[]) => unknown, thisArg, args),
    construct: (_target, args: unknown[]) =>
      Reflect.construct(live(name) as new (...args: unknown[]) => object, args),
    get: (_target, key) => Reflect.get(live(name), key),
    set: (_target, key, value) => Reflect.set(live(name), key, value),
    has: (_target, key) => Reflect.has(live(name), key),
    deleteProperty: (_target, key) => Reflect.deleteProperty(live(name), key),
    // The target can't hold a non-configurable property, so a proxy can't report one: refuse it
    // before it is defined, instead of defining it and failing the invariant check after.
    defineProperty: (_target, key, descriptor) =>
      descriptor.configurable === false
        ? false
        : Reflect.defineProperty(live(name), key, descriptor),
    preventExtensions: () => false,
    ownKeys: () => Reflect.ownKeys(live(name)),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(live(name), key)
      // The target is extensible, so a descriptor for a property it lacks must be configurable.
      return descriptor === undefined ? undefined : { ...descriptor, configurable: true }
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(live(name)),
  })
  return proxy as unknown as WorkerApi[K]
}

/**
 * `describe`: groups tests, as the Jest dialect's global does.
 * @public
 */
export const describe: WorkerApi['describe'] = bound('describe')

/**
 * `it`: defines a test.
 * @public
 */
export const it: WorkerApi['it'] = bound('it')

/**
 * `test`: defines a test.
 * @public
 */
export const test: WorkerApi['test'] = bound('test')

/**
 * `beforeAll`: runs once before the tests of the enclosing `describe`.
 * @public
 */
export const beforeAll: WorkerApi['beforeAll'] = bound('beforeAll')

/**
 * `afterAll`: runs once after the tests of the enclosing `describe`.
 * @public
 */
export const afterAll: WorkerApi['afterAll'] = bound('afterAll')

/**
 * `beforeEach`: runs before each test of the enclosing `describe`.
 * @public
 */
export const beforeEach: WorkerApi['beforeEach'] = bound('beforeEach')

/**
 * `afterEach`: runs after each test of the enclosing `describe`.
 * @public
 */
export const afterEach: WorkerApi['afterEach'] = bound('afterEach')

/**
 * `expect`: the running worker's `expect`, with its matchers, `extend` and asymmetric matchers.
 * @public
 */
export const expect: WorkerApi['expect'] = bound('expect')
