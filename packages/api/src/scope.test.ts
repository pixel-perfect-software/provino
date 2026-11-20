import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import type { RuntimeApi } from '@provino/core'
import { LazyError, lazy } from '@provino/lazy'
import { createMockRegistry, type MockRegistry } from '@provino/mock'
import { neutralPolicy } from '@provino/policy'
import { createFakeClock, type FakeClock } from '@provino/timers'
import type {
  DefaultRetry,
  DescribeRetry,
  DescribeRetryResult,
  FileRegistry,
  ModuleMockRegistry,
} from '@provino/types'
import { type ApiHost, PROVINO_API_SLOT, provinoGlobals, provinoModuleScope } from './index.ts'

const API_NAMES = [
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
] as const

const LAZY_NAMES = [
  'evaluatedLazies',
  'includeContext',
  'includeExamples',
  'itBehavesLike',
  'LazyError',
  'lazy',
  'sharedContext',
  'sharedExamples',
]

const OWN_NAMES = ['expect', 'fn', 'spyOn', 'replaceProperty', 'isMockFunction', 'mocks', 'timers']

/** A host whose "file running now" the test moves by hand: each file has its own registry and clock. */
function fakeHost(): { host: ApiHost; next(): void; registry(): MockRegistry } {
  // Each entry is a distinct function, so the test can tell which one the namespace holds.
  const api = Object.fromEntries(
    API_NAMES.map((name) => [name, Object.defineProperty(() => {}, 'name', { value: name })]),
  ) as unknown as RuntimeApi
  let registry = createMockRegistry()
  let clock: FakeClock = createFakeClock(globalThis, neutralPolicy.timers)
  const unused = (): never => {
    throw new Error('not used by the native API')
  }
  const host: ApiHost = {
    api,
    expect: Object.assign(() => {}, { extend: () => {} }) as unknown as ApiHost['expect'],
    registry: unused as () => FileRegistry,
    mocks: () => registry,
    moduleMocks: unused as () => ModuleMockRegistry,
    mockPolicy: neutralPolicy.mock,
    timers: () => clock,
    timersPolicy: neutralPolicy.timers,
    seed: 1,
    environmentTornDown: () => false,
    setDefaultTimeout: (_ms: number | undefined) => {},
    setDefaultRetry: (_retry: DefaultRetry | undefined) => {},
    setDescribeRetry: (_retry: DescribeRetry): DescribeRetryResult => unused(),
  }
  return {
    host,
    next: () => {
      clock.uninstall()
      registry = createMockRegistry()
      clock = createFakeClock(globalThis, neutralPolicy.timers)
    },
    registry: () => registry,
  }
}

function served(host: ApiHost, from = '/project/a.test.ts'): Record<string, unknown> {
  const scope = provinoModuleScope(host)(from)
  return scope.provino as Record<string, unknown>
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, PROVINO_API_SLOT)
})

describe('provinoModuleScope', () => {
  test('serves `provino` with every export, and declares no binding', () => {
    const { host } = fakeHost()
    const scope = provinoModuleScope(host)('/project/a.test.ts')
    assert.deepEqual(Object.keys(scope), [])
    assert.ok(Object.hasOwn(scope, 'provino'))
    const namespace = served(host)
    assert.deepEqual(
      Object.keys(namespace).sort(),
      [...API_NAMES, ...OWN_NAMES, ...LAZY_NAMES].sort(),
    )
    for (const name of API_NAMES) assert.equal(namespace[name], host.api[name], name)
    assert.equal(namespace.expect, host.expect)
    assert.equal(namespace.lazy, lazy)
    assert.equal(namespace.LazyError, LazyError)
  })

  test('every module gets the same frozen namespace, so `expect === expect`', () => {
    const { host } = fakeHost()
    const scope = provinoModuleScope(host)
    const a = scope('/project/a.test.ts')
    const b = scope('/project/helper.ts')
    assert.equal(a, b)
    assert.equal(a.provino, b.provino)
    assert.ok(Object.isFrozen(a.provino))
    assert.ok(Object.isFrozen(a))
  })

  test('installs the API in the `provino.api` slot, configurable', () => {
    const { host } = fakeHost()
    provinoModuleScope(host)
    assert.equal(PROVINO_API_SLOT, Symbol.for('provino.api'))
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, PROVINO_API_SLOT)
    assert.ok(descriptor !== undefined)
    assert.equal(descriptor.configurable, true)
    assert.equal(descriptor.enumerable, false)
    assert.equal(descriptor.value, provinoGlobals(host))
  })

  test('`fn` and `spyOn` register with the registry of the file running now', () => {
    const { host, next, registry } = fakeHost()
    const namespace = served(host) as unknown as ReturnType<typeof provinoGlobals>
    const first = registry()
    const mock = namespace.fn((a: number) => a + 1)
    assert.equal(mock(1), 2)
    assert.equal(mock.mock.calls.length, 1)
    assert.ok(namespace.isMockFunction(mock))
    assert.ok(!namespace.isMockFunction(() => {}))
    first.clearAll()
    assert.equal(mock.mock.calls.length, 0)

    next()
    const target = { greet: (name: string) => `hi ${name}` }
    const spy = namespace.spyOn(target, 'greet')
    target.greet('ada')
    assert.equal(spy.mock.calls.length, 1)
    // The second file's registry restores it; the first's knows nothing of it.
    first.restoreAll()
    assert.ok(namespace.isMockFunction(target.greet))
    namespace.mocks.restoreAll()
    assert.equal(namespace.isMockFunction(target.greet), false)
    assert.equal(target.greet('ada'), 'hi ada')
  })

  test('`replaceProperty` and `mocks` act on the file running now', () => {
    const { host } = fakeHost()
    const api = provinoGlobals(host)
    const target = { level: 1 }
    api.replaceProperty(target, 'level', 2)
    assert.equal(target.level, 2)
    api.mocks.restoreAll()
    assert.equal(target.level, 1)
    const mock = api.fn(() => 'real')
    mock.mockReturnValue('mocked')
    mock()
    api.mocks.resetAll()
    assert.equal(mock.mock.calls.length, 0)
    // The implementation `fn` was given stays; the one set later goes.
    assert.equal(mock(), 'real')
  })

  test('`timers` drives the clock of the file running now, and chains (facadeReturns: all)', () => {
    const { host, next } = fakeHost()
    const { timers } = provinoGlobals(host)
    try {
      assert.equal(timers.useFakeTimers(), timers)
      assert.equal(timers.isFakeTimers(), true)
      let fired = 0
      setTimeout(() => void fired++, 100)
      assert.equal(timers.getTimerCount(), 1)
      assert.equal(timers.advanceTimersByTime(100), timers)
      assert.equal(fired, 1)
      assert.equal(timers.useRealTimers(), timers)
      assert.equal(timers.isFakeTimers(), false)
      next()
      assert.equal(timers.isFakeTimers(), false)
    } finally {
      timers.useRealTimers()
    }
  })
})

describe('provinoGlobals', () => {
  test('is the same object the served module holds, without the lazy variables', () => {
    const { host } = fakeHost()
    const globals = provinoGlobals(host)
    assert.equal(provinoGlobals(host), globals)
    assert.deepEqual(Object.keys(globals).sort(), [...API_NAMES, ...OWN_NAMES].sort())
    const namespace = served(host)
    for (const name of Object.keys(globals)) {
      assert.equal(namespace[name], (globals as unknown as Record<string, unknown>)[name], name)
    }
    assert.ok(!('lazy' in globals))
  })
})
