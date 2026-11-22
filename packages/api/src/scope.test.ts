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
import {
  type ApiHost,
  PROVINO_API_SLOT,
  type ProvinoApi,
  ProvinoApiError,
  provinoGlobals,
  provinoModuleScope,
  uninstallProvinoApi,
} from './index.ts'

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

/** Served per module (they resolve from it), in the slot too, never globals. */
const MODULE_NAMES = ['mock', 'unmock', 'importActual']

/** A host whose "file running now" the test moves by hand: each file has its own registry and clock. */
function fakeHost(): {
  host: ApiHost
  next(): void
  registry(): MockRegistry
  fileCalls: unknown[][]
} {
  // Each entry is a distinct function, so the test can tell which one the namespace holds.
  const api = Object.fromEntries(
    API_NAMES.map((name) => [name, Object.defineProperty(() => {}, 'name', { value: name })]),
  ) as unknown as RuntimeApi
  let registry = createMockRegistry()
  let clock: FakeClock = createFakeClock(globalThis, neutralPolicy.timers)
  const unused = (): never => {
    throw new Error('not used by the native API')
  }
  // What the module-mock members ask of the file registry running now.
  const fileCalls: unknown[][] = []
  const fileRegistry = {
    registerMock: (...args: unknown[]) => void fileCalls.push(['registerMock', ...args]),
    unregisterMock: (...args: unknown[]) => void fileCalls.push(['unregisterMock', ...args]),
    importActual: async (...args: unknown[]) => {
      fileCalls.push(['importActual', ...args])
      return { real: true }
    },
  } as unknown as FileRegistry
  const host: ApiHost = {
    api,
    expect: Object.assign(() => {}, { extend: () => {} }) as unknown as ApiHost['expect'],
    registry: () => fileRegistry,
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
    fileCalls,
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
      [...API_NAMES, ...OWN_NAMES, ...MODULE_NAMES, ...LAZY_NAMES].sort(),
    )
    for (const name of API_NAMES) assert.equal(namespace[name], host.api[name], name)
    assert.equal(namespace.expect, host.expect)
    assert.equal(namespace.lazy, lazy)
    assert.equal(namespace.LazyError, LazyError)
  })

  test('each module gets its own frozen namespace over the same values, so `expect === expect`', () => {
    const { host } = fakeHost()
    const scope = provinoModuleScope(host)
    const a = scope('/project/a.test.ts')
    const b = scope('/project/helper.ts')
    // The same module gets the same namespace each time it asks.
    assert.equal(scope('/project/a.test.ts'), a)
    assert.notEqual(a.provino, b.provino)
    assert.ok(Object.isFrozen(a.provino))
    assert.ok(Object.isFrozen(a))
    const first = a.provino as Record<string, unknown>
    const second = b.provino as Record<string, unknown>
    for (const name of [...API_NAMES, ...OWN_NAMES, ...LAZY_NAMES]) {
      assert.equal(first[name], second[name], name)
    }
    // Only the module-mock members are the module's own: they resolve from it.
    for (const name of MODULE_NAMES) assert.notEqual(first[name], second[name], name)
  })

  test('installs the API in the `provino.api` slot, configurable', () => {
    const { host } = fakeHost()
    provinoModuleScope(host)
    assert.equal(PROVINO_API_SLOT, Symbol.for('provino.api'))
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, PROVINO_API_SLOT)
    assert.ok(descriptor !== undefined)
    assert.equal(descriptor.configurable, true)
    assert.equal(descriptor.enumerable, false)
    const slot = descriptor.value as Record<string, unknown>
    for (const [name, value] of Object.entries(provinoGlobals(host))) {
      assert.equal(slot[name], value, name)
    }
    // The slot has the module-mock members too, resolving from the test file running now.
    for (const name of MODULE_NAMES) assert.equal(typeof slot[name], 'function', name)
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
    assert.ok(Object.isFrozen(globals))
    // A global `mock` would not be hoisted: the module-mock names are imports only.
    for (const name of MODULE_NAMES) assert.ok(!(name in globals), name)
    const namespace = served(host)
    for (const name of Object.keys(globals)) {
      assert.equal(namespace[name], (globals as unknown as Record<string, unknown>)[name], name)
    }
    assert.ok(!('lazy' in globals))
  })
})

describe('the slot at stop', () => {
  test('disposing the scope takes the slot out, only while it holds this API', () => {
    const first = fakeHost().host
    const scope = provinoModuleScope(first)
    assert.ok(Object.hasOwn(globalThis, PROVINO_API_SLOT))
    scope[Symbol.dispose]()
    assert.equal(Object.hasOwn(globalThis, PROVINO_API_SLOT), false)

    // A later worker in the same process installed its own: the first one's uninstall leaves it.
    const firstApi = Reflect.get(globalThis, PROVINO_API_SLOT) as ProvinoApi | undefined
    assert.equal(firstApi, undefined)
    provinoModuleScope(first)
    const installed = Reflect.get(globalThis, PROVINO_API_SLOT) as ProvinoApi
    Reflect.deleteProperty(globalThis, PROVINO_API_SLOT)
    const second = fakeHost().host
    provinoModuleScope(second)
    const secondApi = Reflect.get(globalThis, PROVINO_API_SLOT) as ProvinoApi
    assert.equal(uninstallProvinoApi(installed), false)
    assert.equal(secondApi.fn, provinoGlobals(second).fn)
    assert.equal(uninstallProvinoApi(secondApi), true)
    assert.equal(Object.hasOwn(globalThis, PROVINO_API_SLOT), false)
  })
})

describe('module mocks', () => {
  test('mock, unmock and importActual resolve from the module that imported them', async () => {
    const { host, fileCalls } = fakeHost()
    const scope = provinoModuleScope(host)
    const fromTest = scope('/project/a.test.ts').provino as unknown as ProvinoApi
    const fromHelper = scope('/project/lib/helper.ts').provino as unknown as ProvinoApi
    const factory = () => ({ value: 1 })
    fromTest.mock('./dep.ts', factory)
    fromHelper.mock('./dep.ts')
    fromTest.unmock('./other.ts')
    assert.deepEqual(await fromHelper.importActual('./dep.ts'), { real: true })
    assert.deepEqual(fileCalls, [
      [
        'registerMock',
        './dep.ts',
        '/project/a.test.ts',
        { kind: 'factory', factory },
        { hoisted: true },
      ],
      // No factory is the neutral automock.
      [
        'registerMock',
        './dep.ts',
        '/project/lib/helper.ts',
        { kind: 'automock', spy: false },
        { hoisted: true },
      ],
      ['unregisterMock', './other.ts', '/project/a.test.ts'],
      ['importActual', './dep.ts', '/project/lib/helper.ts'],
    ])
  })

  test("the slot's members resolve from the test file running now (no parent)", async () => {
    const { host, fileCalls } = fakeHost()
    provinoModuleScope(host)
    const slot = Reflect.get(globalThis, PROVINO_API_SLOT) as ProvinoApi
    slot.mock('pkg')
    await slot.importActual('pkg')
    assert.deepEqual(
      fileCalls.map(([kind, specifier, parent]) => [kind, specifier, parent]),
      [
        ['registerMock', 'pkg', null],
        ['importActual', 'pkg', null],
      ],
    )
  })

  test('a specifier that is not a string is API_MOCK_SPECIFIER, a bad factory API_MOCK_FACTORY', async () => {
    const { host, fileCalls } = fakeHost()
    const api = provinoModuleScope(host)('/project/a.test.ts').provino as unknown as ProvinoApi
    const misuse = api as unknown as {
      mock(specifier: unknown, factory?: unknown): void
      unmock(specifier: unknown): void
      importActual(specifier: unknown): Promise<unknown>
    }
    const isCode = (code: string) => (error: unknown) =>
      error instanceof ProvinoApiError && error instanceof TypeError && error.code === code
    assert.throws(() => misuse.mock(1), isCode('API_MOCK_SPECIFIER'))
    assert.throws(() => misuse.unmock(null), isCode('API_MOCK_SPECIFIER'))
    await assert.rejects(misuse.importActual({}), isCode('API_MOCK_SPECIFIER'))
    assert.throws(() => misuse.mock('./a', { value: 1 }), isCode('API_MOCK_FACTORY'))
    assert.throws(() => misuse.mock('./a', null), /received null/)
    assert.deepEqual(fileCalls, [])
  })

  test('disposing the scope forgets its namespaces', () => {
    const { host } = fakeHost()
    const scope = provinoModuleScope(host)
    const before = scope('/project/a.test.ts')
    scope[Symbol.dispose]()
    assert.notEqual(scope('/project/a.test.ts'), before)
  })
})
