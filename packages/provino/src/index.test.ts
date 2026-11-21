import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { type ApiHost, PROVINO_API_SLOT, provinoModuleScope } from '@provino/api'
import * as api from './index.ts'

const NAMES = [
  'describe',
  'suite',
  'it',
  'test',
  'beforeAll',
  'afterAll',
  'beforeEach',
  'afterEach',
  'aroundEach',
  'aroundAll',
  'onTestFinished',
  'onTestFailed',
  'expect',
  'fn',
  'spyOn',
  'replaceProperty',
  'isMockFunction',
  'mocks',
  'timers',
]

const API_SLOT = PROVINO_API_SLOT

/** Provino's stateless extras: the lazy-variable forwarders, and the error the entry throws. */
const EXTRAS = [
  'LazyError',
  'ProvinoWorkerApiError',
  'evaluatedLazies',
  'includeContext',
  'includeExamples',
  'itBehavesLike',
  'lazy',
  'sharedContext',
  'sharedExamples',
]

/** Installs `value` as the global `name` for one test, and puts back what was there. */
function install(name: string, value: unknown): void {
  const before = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  restores.push(() => {
    if (before === undefined) Reflect.deleteProperty(globalThis, name)
    else Object.defineProperty(globalThis, name, before)
  })
}
const restores: (() => void)[] = []

/** Installs `api` in the native API's slot for one test. */
function installSlot(api: object): void {
  Object.defineProperty(globalThis, API_SLOT, { value: api, configurable: true })
  restores.push(() => void Reflect.deleteProperty(globalThis, API_SLOT))
}
afterEach(() => {
  // Last installed first, so a name installed twice gets back what it had before both.
  for (const restore of restores.splice(0).reverse()) restore()
})

describe('the provino entry binds late to the worker globals (T1.10)', () => {
  test('exports the native API and the lazy variables, and no engine of its own', () => {
    assert.deepEqual(Object.keys(api).sort(), [...NAMES, ...EXTRAS].sort())
  })

  test('outside a worker, each export throws one error that names it and says why', () => {
    for (const name of NAMES) {
      const value: unknown = Reflect.get(api, name)
      assert.throws(
        () => (value as (...args: unknown[]) => unknown)(),
        (error: unknown) =>
          error instanceof api.ProvinoWorkerApiError &&
          error.code === 'PROVINO_NO_WORKER_API' &&
          error.message.includes(`"${name}"`) &&
          error.message.includes('injectGlobals'),
        name,
      )
      assert.throws(() => Reflect.get(value as object, 'each'), api.ProvinoWorkerApiError, name)
    }
  })

  test('a call goes to the live global with its arguments and `this`', () => {
    const calls: unknown[][] = []
    function live(this: unknown, ...args: unknown[]): string {
      calls.push([this, ...args])
      return 'result'
    }
    install('expect', live)
    const receiver = {}
    assert.equal(Reflect.apply(api.expect as never, receiver, [1, 2]), 'result')
    assert.deepEqual(calls, [[receiver, 1, 2]])
  })

  test('statics read through, so `describe.each`, `it.only` and `expect.extend` need no list', () => {
    const only = (): string => 'only'
    install(
      'it',
      Object.assign((): string => 'it', { only }),
    )
    assert.equal((api.it as unknown as { only: () => string }).only, only)
    assert.equal(api.it.only, only)
    const each = (): string => 'each'
    install(
      'describe',
      Object.assign((): void => {}, { each }),
    )
    assert.equal(api.describe.each, each)
  })

  test('follows the global when a later file replaces it', () => {
    install(
      'test',
      Object.assign((): string => 'first', { tag: 1 }),
    )
    assert.equal((api.test as unknown as () => string)(), 'first')
    install(
      'test',
      Object.assign((): string => 'second', { tag: 2 }),
    )
    assert.equal((api.test as unknown as () => string)(), 'second')
    assert.equal(Reflect.get(api.test, 'tag'), 2)
  })

  test('writes, `in`, deletes and key listing reach the live value', () => {
    const live = Object.assign((): void => {}, { a: 1, b: 2 })
    install('expect', live)
    const proxy = api.expect as unknown as Record<string, unknown>
    assert.ok('a' in proxy)
    assert.ok(!('z' in proxy))
    assert.deepEqual(Object.keys(proxy).sort(), ['a', 'b'])
    proxy.c = 3
    assert.equal((live as unknown as Record<string, unknown>).c, 3)
    delete proxy.a
    assert.ok(!('a' in live))
    Object.defineProperty(proxy, 'd', { value: 4, configurable: true, enumerable: true })
    assert.equal((live as unknown as Record<string, unknown>).d, 4)
  })

  test('new reaches the live constructor, with its arguments and its prototype', () => {
    class Fake {
      readonly a: number
      constructor(a: number) {
        this.a = a
      }
    }
    install('describe', Fake)
    const made = new (api.describe as unknown as new (a: number) => Fake)(5)
    assert.ok(made instanceof Fake)
    assert.equal(made.a, 5)
  })

  test('new on a live value that is not a constructor says so, as it would without the proxy', () => {
    install('it', (): void => {})
    assert.throws(() => new (api.it as unknown as new () => object)(), TypeError)
  })

  test('a non-configurable define is refused, and leaves the live value alone', () => {
    const live = Object.assign((): void => {}, {})
    install('expect', live)
    const proxy = api.expect as unknown as object
    // The proxy cannot report a non-configurable property (the target has none), so it refuses
    // outright instead of throwing a proxy-invariant TypeError after having defined it.
    assert.equal(Reflect.defineProperty(proxy, 'x', { value: 1, configurable: false }), false)
    assert.ok(!('x' in live))
    assert.throws(
      () => Object.defineProperty(proxy, 'x', { value: 1, configurable: false }),
      TypeError,
    )
    assert.ok(!('x' in live))
  })

  test('a configurable define reaches the live value and reads back through the proxy', () => {
    const live = Object.assign((): void => {}, {})
    install('expect', live)
    const proxy = api.expect as unknown as Record<string, unknown>
    assert.equal(
      Reflect.defineProperty(proxy, 'y', {
        value: 2,
        configurable: true,
        enumerable: true,
        writable: true,
      }),
      true,
    )
    assert.equal((live as unknown as Record<string, unknown>).y, 2)
    assert.equal(proxy.y, 2)
    assert.deepEqual(Object.getOwnPropertyDescriptor(proxy, 'y'), {
      value: 2,
      configurable: true,
      enumerable: true,
      writable: true,
    })
  })

  test('it cannot be made non-extensible, so the proxy goes on keeping its invariants', () => {
    const live = Object.assign((): void => {}, { a: 1 })
    install('expect', live)
    const proxy = api.expect as unknown as object
    assert.equal(Reflect.preventExtensions(proxy), false)
    assert.ok(Object.isExtensible(proxy))
    assert.ok(Object.getOwnPropertyDescriptor(proxy, 'a'))
    assert.deepEqual(
      Reflect.ownKeys(proxy).filter((key) => key === 'a'),
      ['a'],
    )
  })

  test('a global that is not a function or an object is not installed', () => {
    install('expect', 'not an api')
    assert.throws(() => (api.expect as unknown as () => void)(), api.ProvinoWorkerApiError)
  })
})

describe('the provino entry reads the native slot first (B27b, D185)', () => {
  test('a call goes to the slot when the native runtime installed one', () => {
    const fromSlot = (): string => 'slot'
    installSlot({ fn: fromSlot, test: fromSlot })
    assert.equal((api.fn as unknown as () => string)(), 'slot')
    assert.equal((api.test as unknown as () => string)(), 'slot')
  })

  test('the slot wins over a global of the same name, and a name it lacks falls back to the global', () => {
    installSlot({ expect: (): string => 'slot' })
    install('expect', (): string => 'global')
    install('describe', (): string => 'global describe')
    assert.equal((api.expect as unknown as () => string)(), 'slot')
    assert.equal((api.describe as unknown as () => string)(), 'global describe')
  })

  test('statics read through the slot too, so `expect.extend` reaches the native expect', () => {
    const extend = (): string => 'extend'
    installSlot({ expect: Object.assign((): void => {}, { extend }) })
    assert.equal(api.expect.extend, extend)
  })

  test('with neither, the slot-only names throw PROVINO_NO_WORKER_API too', () => {
    installSlot({})
    for (const name of ['fn', 'spyOn', 'timers', 'mocks']) {
      assert.throws(
        () => Reflect.get(Reflect.get(api, name) as object, 'x'),
        (error: unknown) =>
          error instanceof api.ProvinoWorkerApiError && error.code === 'PROVINO_NO_WORKER_API',
        name,
      )
    }
  })
})

describe("a native-only name in a dialect's worker (B27b review)", () => {
  test('says it is the native API and names the Jest member to use', () => {
    install('describe', (): void => {})
    for (const [name, jest] of [
      ['fn', 'jest.fn'],
      ['spyOn', 'jest.spyOn'],
      ['timers', 'jest.useFakeTimers'],
    ] as const) {
      assert.throws(
        () => Reflect.get(Reflect.get(api, name) as object, 'x'),
        (error: unknown) =>
          error instanceof api.ProvinoWorkerApiError &&
          error.code === 'PROVINO_NATIVE_ONLY' &&
          error.message.includes(`"${name}" is the native API`) &&
          error.message.includes(jest),
        name,
      )
    }
    // A name Jest has too still says no worker installed it.
    assert.throws(
      () => (api.test as unknown as () => void)(),
      (error: unknown) =>
        error instanceof api.ProvinoWorkerApiError && error.code === 'PROVINO_NO_WORKER_API',
    )
  })

  test('outside any worker, a native-only name says no worker installed it', () => {
    assert.throws(
      () => (api.fn as unknown as () => void)(),
      (error: unknown) =>
        error instanceof api.ProvinoWorkerApiError && error.code === 'PROVINO_NO_WORKER_API',
    )
  })
})

describe('the served namespace and the entry agree (B27b review)', () => {
  test("the served provino module's keys are the entry's runtime exports, but the entry's error", () => {
    const names = [
      'describe',
      'suite',
      'it',
      'test',
      'beforeAll',
      'afterAll',
      'beforeEach',
      'afterEach',
      'aroundEach',
      'aroundAll',
      'onTestFinished',
      'onTestFailed',
    ]
    // Only what the factory reads as it runs; the rest is read when a member is called.
    const host = {
      api: Object.fromEntries(names.map((name) => [name, (): void => {}])),
      expect: (): void => {},
      timersPolicy: { facadeReturns: 'all' },
    } as unknown as ApiHost
    const scope = provinoModuleScope(host)
    try {
      const served = scope('/project/a.test.ts').provino as object
      assert.deepEqual(
        Object.keys(served).sort(),
        Object.keys(api)
          .filter((name) => name !== 'ProvinoWorkerApiError')
          .sort(),
      )
    } finally {
      scope[Symbol.dispose]()
    }
  })
})
