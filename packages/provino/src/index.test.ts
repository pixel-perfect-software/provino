import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import * as api from './index.ts'

const NAMES = [
  'describe',
  'it',
  'test',
  'beforeAll',
  'afterAll',
  'beforeEach',
  'afterEach',
  'expect',
]

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
afterEach(() => {
  for (const restore of restores.splice(0)) restore()
})

describe('the provino entry binds late to the worker globals (T1.10)', () => {
  test('exports the Jest dialect test-definition API, and no engine of its own', () => {
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
