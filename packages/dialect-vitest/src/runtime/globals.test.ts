// `vitestGlobals`, `vitestModuleScope` and `vi` over a host whose registries record what they are
// asked. Behaviour against the real Vitest is `@provino/harness`'s mock, mod, timer and expect
// corpora, which run their Vitest profile through this `vi`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { RuntimeApi } from '@provino/core'
import { createMockRegistry } from '@provino/mock'
import { neutralPolicy } from '@provino/policy'
import { createFakeClock } from '@provino/timers'
import type { FileRegistry, MockSpec, ModuleMockRegistry } from '@provino/types'
import { vitestDialect } from '../dialect.ts'
import { vitestMockPolicy } from '../mock-policy.ts'
import { chaiLoaded } from './expect/chai.ts'
import { type VitestGlobalsHost, vitestGlobals, vitestModuleScope } from './index.ts'
import { setUpVitestExpect } from './internal/expect-setup.ts'

// The matcher slot Chai's plugins and `vi.when`'s equality read, as the worker installs it.
await setUpVitestExpect()

interface Registered {
  readonly path: string
  readonly parent: string | null
  readonly spec: MockSpec
  readonly hoisted: boolean | undefined
}

function makeHost(): {
  host: VitestGlobalsHost
  registered: Registered[]
  unregistered: [string, string | null][]
  timeouts: (number | undefined)[]
} {
  const registered: Registered[] = []
  const unregistered: [string, string | null][] = []
  const timeouts: (number | undefined)[] = []
  const mocks = createMockRegistry()
  const clock = createFakeClock(globalThis, neutralPolicy.timers)
  const api = new Proxy({}, { get: (_target, key) => ({ api: key }) }) as unknown as RuntimeApi
  const registry = {
    registerMock: (
      path: string,
      parent: string | null,
      spec: MockSpec,
      options?: { hoisted?: boolean },
    ) => {
      registered.push({ path, parent, spec, hoisted: options?.hoisted })
    },
    unregisterMock: (path: string, parent: string | null) => {
      unregistered.push([path, parent])
    },
  } as unknown as FileRegistry
  const host: VitestGlobalsHost = {
    api,
    expect: (() => {}) as unknown as VitestGlobalsHost['expect'],
    registry: () => registry,
    mocks: () => mocks,
    moduleMocks: () => ({}) as ModuleMockRegistry,
    mockPolicy: vitestMockPolicy,
    timers: () => clock,
    timersPolicy: neutralPolicy.timers,
    seed: 0,
    environmentTornDown: () => false,
    setDefaultTimeout: (ms) => {
      timeouts.push(ms)
    },
    setDefaultRetry: () => {},
    setDescribeRetry: () => 'set',
  }
  return { host, registered, unregistered, timeouts }
}

/** `Object.keys(vi)` as Vitest 5.0.5 recorded it (`mocking/api-surface`). */
function recordedViKeys(): readonly string[] {
  const golden = JSON.parse(
    readFileSync(
      new URL(
        '../../../harness/fixtures/mocking/api-surface/__goldens__/vitest.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { trace: string[] }
  const line = JSON.parse(golden.trace[0] ?? '') as { value: string[] }
  return line.value
}

test('the globals are the 19 names the dialect lists, and vi is vitest', () => {
  const { host } = makeHost()
  const globals = vitestGlobals(host)
  assert.deepEqual(Object.keys(globals), vitestDialect.globals?.names)
  assert.equal(globals.vi, globals.vitest)
  assert.equal(vitestGlobals(host), globals, 'one set per host')
})

test('vi has the keys Vitest 5.0.5 records, in its order', () => {
  const { host } = makeHost()
  assert.deepEqual(Object.keys(vitestGlobals(host).vi), recordedViKeys())
  assert.deepEqual(Object.keys(vitestModuleScope(host)('/m.ts').vi as object), recordedViKeys())
})

test('building the globals loads no Chai; the first use of assert does', () => {
  const { host } = makeHost()
  const globals = vitestGlobals(host)
  assert.equal(chaiLoaded(), false)
  globals.assert(true)
  assert.equal(chaiLoaded(), true)
  assert.throws(() => globals.assert(false, 'nope'), /nope/)
  assert.equal(typeof Reflect.get(globals.chai, 'use'), 'function')
})

test('each module gets its own vi, and the served vitest hands it the same one', () => {
  const { host } = makeHost()
  const scope = vitestModuleScope(host)
  const a = scope('/a.ts')
  const b = scope('/b.ts')
  assert.deepEqual(Object.keys(a), ['vi'])
  assert.notEqual(a.vi, b.vi)
  assert.equal(scope('/a.ts').vi, a.vi)
  const served = Reflect.get(a, 'vitest') as Record<string, unknown>
  assert.equal(served.vi, a.vi)
  assert.equal(served.vitest, a.vi)
  assert.equal(served.expect, host.expect)
})

test('the served modules: vitest, @vitest/spy, @vitest/expect and vitest/runtime', () => {
  const { host } = makeHost()
  const scope = vitestModuleScope(host)('/a.ts')
  const own = scope.vi
  // The scope's served values are not enumerable, beside the bindings of the same name.
  const served = (name: string): Record<string, unknown> => {
    const descriptor = Object.getOwnPropertyDescriptor(scope, name)
    assert.ok(descriptor !== undefined, name)
    return (descriptor.get?.() ?? descriptor.value) as Record<string, unknown>
  }
  for (const name of ['@vitest/spy', '@vitest/expect', 'vitest/runtime']) {
    assert.equal(Object.keys(scope).includes(name), false, name)
  }
  const spy = served('@vitest/spy')
  const fn = (spy.fn as () => { mock: object })()
  assert.equal((spy.isMockFunction as (value: unknown) => boolean)(fn), true)
  assert.equal(served('@vitest/expect').expect, host.expect)
  assert.equal(typeof served('vitest/runtime').populateGlobal, 'function')
  assert.equal(served('vi'), own)
})

test('vi.mock registers from its module, hoisted; doMock not, and disposes back', () => {
  const { host, registered, unregistered } = makeHost()
  const vi = vitestModuleScope(host)('/dir/a.ts').vi as ReturnType<typeof vitestGlobals>['vi']
  vi.mock('./x.ts', () => ({ x: 1 }))
  vi.mock('./y.ts', { spy: true })
  vi.mock('./z.ts')
  const disposable = vi.doMock('./w.ts') as { [Symbol.dispose](): void }
  assert.deepEqual(
    registered.map((entry) => [entry.path, entry.parent, entry.spec.kind, entry.hoisted]),
    [
      ['./x.ts', '/dir/a.ts', 'factory', true],
      ['./y.ts', '/dir/a.ts', 'automock', true],
      ['./z.ts', '/dir/a.ts', 'automock', true],
      ['./w.ts', '/dir/a.ts', 'automock', false],
    ],
  )
  assert.deepEqual(registered[1]?.spec, { kind: 'automock', spy: true })
  disposable[Symbol.dispose]()
  vi.unmock('./x.ts')
  assert.deepEqual(unregistered, [
    ['./w.ts', '/dir/a.ts'],
    ['./x.ts', '/dir/a.ts'],
  ])
  // vi.ts L696-L698.
  assert.throws(
    () => vi.mock(1 as unknown as string),
    new TypeError('vi.mock() expects a string path, but received a number'),
  )
  assert.throws(
    () => vi.hoisted(null as unknown as () => void),
    new TypeError('"vi.hoisted" factory value must be function, received "object"'),
  )
})

test('stubEnv keeps PROD, DEV and SSR as "1" or "", and unstubAllEnvs puts the values back', () => {
  const { host } = makeHost()
  const { vi } = vitestGlobals(host)
  const before = process.env.DEV
  vi.stubEnv('DEV', true).stubEnv('PROVINO_VI_TEST', 'x').stubEnv('SSR', false)
  assert.equal(process.env.DEV, '1')
  assert.equal(process.env.SSR, '')
  assert.equal(process.env.PROVINO_VI_TEST, 'x')
  vi.unstubAllEnvs()
  assert.equal(process.env.DEV, before)
  assert.equal(process.env.PROVINO_VI_TEST, undefined)
  vi.stubGlobal('__provinoViTest', 1)
  assert.equal(Reflect.get(globalThis, '__provinoViTest'), 1)
  vi.unstubAllGlobals()
  assert.equal(Reflect.has(globalThis, '__provinoViTest'), false)
})

test('setConfig applies testTimeout, and resetConfig takes it back', () => {
  const { host, timeouts } = makeHost()
  const { vi } = vitestGlobals(host)
  vi.setConfig({ testTimeout: 50 })
  vi.resetConfig()
  vi.resetConfig()
  assert.deepEqual(timeouts, [50, undefined])
})

test("one file's setConfig is not the next file's", () => {
  const { host, timeouts } = makeHost()
  const first = createMockRegistry()
  const second = createMockRegistry()
  let file = first
  const perFile: VitestGlobalsHost = { ...host, mocks: () => file }
  const { vi } = vitestGlobals(perFile)
  vi.setConfig({ testTimeout: 50 })
  file = second
  // The next file's resetConfig has nothing of its own to take back.
  vi.resetConfig()
  assert.deepEqual(timeouts, [50])
})

test('vi.when, vi.waitFor and vi.waitUntil, on calls that settle at once', async () => {
  const { host } = makeHost()
  const { vi } = vitestGlobals(host)
  const spy = vi.fn((n: number) => n)
  const chain = vi
    .when(spy as never)
    .calledWith(1)
    .thenReturn(10)
  assert.equal(vi.isWhenChain(chain), true)
  assert.equal(spy(1), 10)
  assert.equal(spy(2), 2)
  // The clock is not installed, so the first check settles each.
  assert.equal(await vi.waitFor(() => 3), 3)
  assert.equal(await vi.waitUntil(() => 'ok'), 'ok')
  assert.deepEqual(vi.mockObject({ f: () => 1 }).f(), undefined)
})

/** The `observe` reduction of the values these cases return: `undefined` and errors. */
function reduced(value: unknown): unknown {
  if (value === undefined) return { $: 'undefined' }
  if (value instanceof Error) return { $: 'error', name: value.name, message: value.message }
  if (Array.isArray(value)) return value.map(reduced)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reduced(item)]))
  }
  return value
}

test('vi.when, isWhenChain, waitFor and waitUntil give what Vitest 5.0.5 recorded (mocking/vi-when-wait)', async () => {
  const { vi } = vitestGlobals(makeHost().host)
  const attempt = (run: () => unknown) => {
    try {
      return { value: run() }
    } catch (error) {
      return { threw: error }
    }
  }
  const cases: Record<string, () => unknown> = {
    'when returns per argument and falls back for others': () => {
      const f = vi.fn((x: unknown) => `impl ${String(x)}`)
      const chain = vi.when(f).calledWith(1).thenReturn('one')
      return { first: f(1), other: f(2), isChain: vi.isWhenChain(chain), plain: vi.isWhenChain({}) }
    },
    'when with thenReturnOnce and thenThrow': () => {
      const f = vi.fn()
      vi.when(f).calledWith('a').thenReturnOnce('once')
      vi.when(f).calledWith('b').thenThrow(new Error('b throws'))
      return [f('a'), f('a'), attempt(() => f('b'))]
    },
    'when with onUnmatched throw': () => {
      const f = vi.fn()
      vi.when(f, { onUnmatched: 'throw' }).calledWith(1).thenReturn('one')
      return [attempt(() => f(1)), attempt(() => f(2))]
    },
    'waitFor resolves with the callback value at once': async () => {
      let calls = 0
      const value = await vi.waitFor(() => {
        calls++
        return 'ready'
      })
      return { value, calls }
    },
    'waitUntil resolves with the first truthy value': async () => {
      let calls = 0
      const value = await vi.waitUntil(() => {
        calls++
        return { ok: true }
      })
      return { value, calls }
    },
  }
  const golden = JSON.parse(
    readFileSync(
      new URL(
        '../../../harness/fixtures/mocking/vi-when-wait/__goldens__/vitest.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { trace: readonly string[] }
  const recorded = golden.trace.map((line) => JSON.parse(line) as { id: string; value: unknown })
  assert.deepEqual(
    recorded.map((entry) => entry.id),
    Object.keys(cases),
  )
  for (const entry of recorded) {
    const run = cases[entry.id]
    assert.ok(run)
    assert.deepEqual(reduced(await run()), entry.value, entry.id)
  }
})
