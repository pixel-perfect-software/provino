// `provino`: what a test file imports. In a project with no dialect, the worker's loader serves this
// module itself (D185): an import of `provino` never reaches this file, and gets the worker's own
// `describe`, `expect`, `fn` and the rest (`@provino/api`). This file is what everything else
// reaches: a module the loader doesn't serve (a `node_modules` helper Node loads itself), a Jest
// project, code outside a worker. Its exports are forwarders that read, when they are used, the
// native API's slot (`Symbol.for('provino.api')`, which the native runtime installs as the worker
// boots), then the globals a dialect installed (`injectGlobals`, on unless a project turns it
// off), and throw `PROVINO_NO_WORKER_API` when there is neither. The lazy variables (`lazy`, the
// shared examples) are neutral and never globals: they read the runtime the worker puts in a slot of
// their own, so they work with `injectGlobals` off.
//
// At run time this file imports only the lazy forwarders (a few small functions that read the slot
// when called) and, through them, `dist/lazy-api.js`: the error class, the call-site marker and the
// slot reader, in a chunk of their own (`tooling/packaging/src/umbrella.ts`, group `lazy-api`).
// `import 'provino'` loads no `shared.js`, `loading.js` or coordinator chunk. The worker's engine is
// in those, and a test file reaching `provino` must not load a second copy: a copy of `expect`
// would have its own matchers and its own state, not the test's.
import type { ProvinoApi } from '@provino/api'
import type { JestGlobals } from '@provino/dialect-jest/runtime'
import type { Mocked } from '@provino/mock'

export type {
  ProvinoApi,
  ProvinoMock,
  ProvinoMockFactory,
  ProvinoMocks,
  ProvinoSpyOn,
  ProvinoTimers,
} from '@provino/api'
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
export type {
  Mock,
  Mocked,
  MockedClass,
  MockedFunction,
  MockedObject,
  MockImplementation,
  MockInstance,
} from '@provino/mock'

/**
 * The worker API's old name: the Jest dialect's test-definition globals, as the Jest dialect
 * builds them.
 * @deprecated Use `ProvinoApi` in a project with no dialect; `WorkerApi` goes in the next rc.
 * @public
 */
export type WorkerApi = Pick<
  JestGlobals,
  'afterAll' | 'afterEach' | 'beforeAll' | 'beforeEach' | 'describe' | 'expect' | 'it' | 'test'
>

/**
 * The codes of `ProvinoWorkerApiError`: no worker installed the API (`PROVINO_NO_WORKER_API`), or
 * a dialect's worker is running and the name is the native API's alone (`PROVINO_NATIVE_ONLY`).
 * @public
 */
export type ProvinoWorkerApiErrorCode = 'PROVINO_NO_WORKER_API' | 'PROVINO_NATIVE_ONLY'

/**
 * What a Jest project uses in place of each name only the native API has.
 */
const JEST_INSTEAD: Readonly<Record<string, string>> = {
  fn: 'jest.fn',
  spyOn: 'jest.spyOn',
  replaceProperty: 'jest.replaceProperty',
  isMockFunction: 'jest.isMockFunction',
  mocks: 'jest.clearAllMocks, jest.resetAllMocks and jest.restoreAllMocks',
  timers: 'jest.useFakeTimers and the other timer members of jest',
  mock: 'jest.mock',
  unmock: 'jest.unmock',
  importActual: 'jest.requireActual',
  requireActual: 'jest.requireActual',
  mocked: 'jest.mocked',
  resetModules: 'jest.resetModules',
  isolateModules: 'jest.isolateModules',
  isolateModulesAsync: 'jest.isolateModulesAsync',
}

/** The names only the native API has (a Jest project's worker installs none of them). */
const NATIVE_ONLY: ReadonlySet<string> = new Set([
  ...Object.keys(JEST_INSTEAD),
  'suite',
  'aroundEach',
  'aroundAll',
  'onTestFinished',
  'onTestFailed',
  'stubGlobal',
  'stubEnv',
  'unstubAllGlobals',
  'unstubAllEnvs',
])

/**
 * Thrown by every `provino` export used where no worker has installed it (outside a test file
 * Provino is running, or in a dialect's project with `injectGlobals` off), and by a name only the
 * native API has, used in a dialect's project.
 * @public
 */
export class ProvinoWorkerApiError extends Error {
  readonly code: ProvinoWorkerApiErrorCode

  constructor(name: string, code: ProvinoWorkerApiErrorCode = 'PROVINO_NO_WORKER_API') {
    const instead = JEST_INSTEAD[name]
    super(
      code === 'PROVINO_NATIVE_ONLY'
        ? `provino: "${name}" is the native API, for a project with no dialect; ${instead === undefined ? "the dialect's globals have no such name" : `in a Jest project use ${instead}`}.`
        : `provino: "${name}" is only available inside a test file that Provino is running: in a project with no dialect, or with a dialect's globals injected (injectGlobals is on by default).`,
    )
    this.name = 'ProvinoWorkerApiError'
    this.code = code
  }
}

/** Where the native runtime puts its API (`@provino/api`'s `PROVINO_API_SLOT`). */
const API_SLOT: unique symbol = Symbol.for('provino.api')

/**
 * The live value of `name`: the native API's, else the global a dialect installed, else the error
 * that says there is none. A native-only name in a dialect's worker (its `describe` is a global)
 * says it is the native API's.
 */
function live(name: string): object {
  const api: unknown = Reflect.get(globalThis, API_SLOT)
  const value: unknown =
    (typeof api === 'object' && api !== null ? Reflect.get(api, name) : undefined) ??
    Reflect.get(globalThis, name)
  if ((typeof value === 'function' || typeof value === 'object') && value !== null) return value
  const dialectWorker =
    NATIVE_ONLY.has(name) && typeof Reflect.get(globalThis, 'describe') === 'function'
  throw new ProvinoWorkerApiError(
    name,
    dialectWorker ? 'PROVINO_NATIVE_ONLY' : 'PROVINO_NO_WORKER_API',
  )
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
function bound<K extends keyof ProvinoApi>(name: K): ProvinoApi[K] {
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
  return proxy as unknown as ProvinoApi[K]
}

/**
 * `describe`: groups tests.
 * @public
 */
export const describe: ProvinoApi['describe'] = bound('describe')

/**
 * `suite`: `describe`.
 * @public
 */
export const suite: ProvinoApi['suite'] = bound('suite')

/**
 * `it`: defines a test.
 * @public
 */
export const it: ProvinoApi['it'] = bound('it')

/**
 * `test`: defines a test.
 * @public
 */
export const test: ProvinoApi['test'] = bound('test')

/**
 * `beforeAll`: runs once before the tests of the enclosing `describe`.
 * @public
 */
export const beforeAll: ProvinoApi['beforeAll'] = bound('beforeAll')

/**
 * `afterAll`: runs once after the tests of the enclosing `describe`.
 * @public
 */
export const afterAll: ProvinoApi['afterAll'] = bound('afterAll')

/**
 * `beforeEach`: runs before each test of the enclosing `describe`.
 * @public
 */
export const beforeEach: ProvinoApi['beforeEach'] = bound('beforeEach')

/**
 * `afterEach`: runs after each test of the enclosing `describe`.
 * @public
 */
export const afterEach: ProvinoApi['afterEach'] = bound('afterEach')

/**
 * `aroundEach`: wraps each test's hooks and body.
 * @public
 */
export const aroundEach: ProvinoApi['aroundEach'] = bound('aroundEach')

/**
 * `aroundAll`: wraps a suite's hooks and tests.
 * @public
 */
export const aroundAll: ProvinoApi['aroundAll'] = bound('aroundAll')

/**
 * `onTestFinished`: runs after the current test.
 * @public
 */
export const onTestFinished: ProvinoApi['onTestFinished'] = bound('onTestFinished')

/**
 * `onTestFailed`: runs after the current test when it failed.
 * @public
 */
export const onTestFailed: ProvinoApi['onTestFailed'] = bound('onTestFailed')

/**
 * `expect`: the running worker's `expect`, with its matchers, `extend` and asymmetric matchers. A Proxy, so `expect.extend` and the asymmetric statics read through.
 * @public
 */
export const expect: ProvinoApi['expect'] = bound('expect')

/**
 * `fn`: a mock function, registered with the file running now (native API).
 * @public
 */
export const fn: ProvinoApi['fn'] = bound('fn')

/**
 * `spyOn`: replaces a method or accessor with a spy that calls through (native API).
 * @public
 */
export const spyOn: ProvinoApi['spyOn'] = bound('spyOn')

/**
 * `replaceProperty`: replaces a plain value property until it is restored (native API).
 * @public
 */
export const replaceProperty: ProvinoApi['replaceProperty'] = bound('replaceProperty')

/**
 * `stubGlobal`: stands a value in for a global, even a missing or accessor one, until
 * `unstubAllGlobals()` or the end of the test (native API).
 * @public
 */
export const stubGlobal: ProvinoApi['stubGlobal'] = bound('stubGlobal')

/**
 * `stubEnv`: sets an environment variable (`undefined` deletes it) until `unstubAllEnvs()` or
 * the end of the test (native API).
 * @public
 */
export const stubEnv: ProvinoApi['stubEnv'] = bound('stubEnv')

/**
 * `unstubAllGlobals`: puts back every global `stubGlobal` stood in for (native API).
 * @public
 */
export const unstubAllGlobals: ProvinoApi['unstubAllGlobals'] = bound('unstubAllGlobals')

/**
 * `unstubAllEnvs`: puts back every environment variable `stubEnv` changed (native API).
 * @public
 */
export const unstubAllEnvs: ProvinoApi['unstubAllEnvs'] = bound('unstubAllEnvs')

/**
 * `isMockFunction`: whether a value is a mock function (native API).
 * @public
 */
export const isMockFunction: ProvinoApi['isMockFunction'] = bound('isMockFunction')

/**
 * `mocks`: the file's mock registry: `clearAll`, `resetAll`, `restoreAll` (native API).
 * @public
 */
export const mocks: ProvinoApi['mocks'] = bound('mocks')

/**
 * `timers`: the file's fake clock (native API).
 * @public
 */
export const timers: ProvinoApi['timers'] = bound('timers')

/**
 * `mock`: replaces a module with a factory's exports, or an automock (native API). Imported from
 * `provino` in a file the worker serves, a top-level call is hoisted above the file's imports and
 * resolves from that file; through this entry it resolves from the test file running now.
 * @public
 */
export const mock: ProvinoApi['mock'] = bound('mock')

/**
 * `unmock`: takes a module mock away again (native API; hoisted like `mock`).
 * @public
 */
export const unmock: ProvinoApi['unmock'] = bound('unmock')

/**
 * `importActual`: the real module, past any mock of it (native API).
 * @public
 */
export const importActual: ProvinoApi['importActual'] = bound('importActual')

/**
 * `requireActual`: the real module, past any mock of it, loaded synchronously (native API).
 * @public
 */
export const requireActual: ProvinoApi['requireActual'] = bound('requireActual')

/**
 * `resetModules`: forgets the file's module instances, so the next import evaluates each module
 * again (native API).
 * @public
 */
export const resetModules: ProvinoApi['resetModules'] = bound('resetModules')

/**
 * `isolateModules`: runs a function with a fresh module registry and returns its value; a `mock`
 * at the top of the function is hoisted to the top of it (native API).
 * @public
 */
export const isolateModules: ProvinoApi['isolateModules'] = bound('isolateModules')

/**
 * `isolateModulesAsync`: `isolateModules` for an async function (native API).
 * @public
 */
export const isolateModulesAsync: ProvinoApi['isolateModulesAsync'] = bound('isolateModulesAsync')

/**
 * `mocked`: `value`, typed with the mock methods of `Mocked`. It does nothing at run time, so it
 * works anywhere, in or out of a worker.
 * @public
 */
export const mocked: ProvinoApi['mocked'] = <T>(value: T): Mocked<T> => value as Mocked<T>
