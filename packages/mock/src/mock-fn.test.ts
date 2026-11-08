import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { flipped, neutral, policies } from './internal/test-support.ts'
import { createMockFn, isMockFunction, MOCK_BRAND } from './mock-fn.ts'
import { createMockRegistry } from './registry.ts'
import { spyOn } from './spy.ts'
import type { UnknownFunction } from './types.ts'

const fnOf = (policy: typeof neutral) => {
  const registry = createMockRegistry()
  return {
    registry,
    fn: (impl?: UnknownFunction) =>
      impl === undefined
        ? createMockFn(policy, registry)
        : createMockFn<UnknownFunction>(policy, registry, { impl }),
  }
}

for (const [name, policy] of policies) {
  describe(`recording (${name})`, () => {
    test('calls keep argument references, results start incomplete, order counts from 1', () => {
      const { fn, registry } = fnOf(policy)
      const first = fn()
      const second = fn()
      const argument = {}
      let during: unknown
      const inner = fn(function (this: unknown) {
        during = structuredClone(inner.mock.results.at(-1))
        return 'ok'
      })
      first(argument)
      second()
      first()
      inner()
      assert.equal(first.mock.calls[0]?.[0], argument)
      assert.deepEqual(first.mock.invocationCallOrder, [1, 3])
      assert.deepEqual(second.mock.invocationCallOrder, [2])
      assert.deepEqual(during, { type: 'incomplete', value: undefined })
      assert.deepEqual(inner.mock.results, [{ type: 'return', value: 'ok' }])
      assert.equal(registry.nextInvocationOrder(), 5)
    })

    test('contexts hold `this`, a throw is recorded and rethrown', () => {
      const { fn } = fnOf(policy)
      const boom = new Error('boom')
      const f = fn(() => {
        throw boom
      })
      const self = { f }
      assert.throws(() => self.f(), boom)
      assert.equal(f.mock.contexts[0], self)
      assert.deepEqual(f.mock.results, [{ type: 'throw', value: boom }])
    })

    test('a mockClear inside the implementation wipes the call in flight', () => {
      const { fn } = fnOf(policy)
      const f = fn(() => {
        f.mockClear()
        return 1
      })
      assert.equal(f(), 1)
      assert.equal(f.mock.calls.length, 0)
      assert.equal(f.mock.results.length, 0)
    })

    test('implementations: once queue before the persistent one, shorthands, this', async () => {
      const { fn } = fnOf(policy)
      const f = fn(() => 'persistent')
      f.mockImplementationOnce(() => 'a').mockReturnValueOnce('b')
      assert.deepEqual([f(), f(), f()], ['a', 'b', 'persistent'])
      f.mockReturnValue('value')
      assert.equal(f(), 'value')
      f.mockResolvedValue('resolved')
      assert.equal(await f(), 'resolved')
      f.mockRejectedValueOnce(new Error('no'))
      await assert.rejects(f() as Promise<unknown>, /no/)
      f.mockThrowOnce(new Error('thrown'))
      assert.throws(() => f(), /thrown/)
      f.mockThrow('always')
      assert.throws(
        () => f(),
        (error) => error === 'always',
      )
      f.mockReturnThis()
      const self = { f }
      assert.equal(self.f(), self)
    })

    test('withImplementation swaps, then puts back, sync and async', async () => {
      const { fn } = fnOf(policy)
      const f = fn(() => 'before')
      f.mockImplementationOnce(() => 'queued')
      f.withImplementation(
        () => 'during',
        () => assert.equal(f(), 'during'),
      )
      assert.deepEqual([f(), f()], ['queued', 'before'])
      await f.withImplementation(
        () => 'async',
        async () => {
          assert.equal(f(), 'async')
        },
      )
      assert.equal(f(), 'before')
    })

    test('whenCalledWith routes equal arguments to its sub-mock and falls through', () => {
      const { fn } = fnOf(policy)
      const f = fn(() => 'fallback')
      const matched = f.whenCalledWith({ a: [1] })
      matched.mockReturnValue('matched')
      assert.equal(f({ a: [1] }), 'matched')
      assert.equal(f({ a: [2] }), 'fallback')
      assert.equal(matched.mock.calls.length, 1)
      assert.equal(f.getMockImplementation()?.(), 'fallback')
      f.whenCalledWith({ a: [1] }).mockReturnValueOnce('once')
      assert.equal(f({ a: [1] }), 'once')
      f.mockReset()
      assert.equal(matched.mock.calls.length, 0)
    })

    test('a mock has one own enumerable string key, and its methods are on a frozen prototype', () => {
      const { fn } = fnOf(policy)
      const f = fn()
      const g = fn(() => 1)
      assert.deepEqual(Object.keys(f), ['mock'])
      assert.equal(Object.getOwnPropertyDescriptor(f, 'mock')?.enumerable, true)
      const proto = Object.getPrototypeOf(f)
      assert.equal(proto, Object.getPrototypeOf(g))
      assert.ok(Object.isFrozen(proto))
      assert.equal(Object.getPrototypeOf(proto), Function.prototype)
      assert.equal(Object.hasOwn(f, 'mockClear'), false)
      assert.equal(typeof f.bind, 'function')
      assert.equal((f as unknown as Record<symbol, unknown>)[MOCK_BRAND], true)
      assert.equal(f._isMockFunction, true)
      assert.ok(isMockFunction(policy, f))
    })

    test('a method taken off its mock works with no `this`', () => {
      const { fn } = fnOf(policy)
      const f = fn()
      const { mockReturnValue, mockClear, getMockName } = f
      assert.equal(mockReturnValue(1), f)
      assert.equal(f(), 1)
      assert.equal(f.mock.calls.length, 1)
      mockClear.call(undefined as never)
      assert.equal(f.mock.calls.length, 0)
      assert.equal(getMockName(), policy.defaultName)
    })

    test('a method read twice is the same closure, and each mock has its own', () => {
      const { fn } = fnOf(policy)
      const f = fn()
      const g = fn()
      assert.equal(f.mockClear, f.mockClear)
      assert.equal(f[Symbol.dispose], f[Symbol.dispose])
      assert.notEqual(f.mockClear, g.mockClear)
      f.mockReturnValue(1)
      assert.equal(g(), undefined)
    })

    test('a method keeps its length and returns what it returns', () => {
      const { fn } = fnOf(policy)
      const f = fn()
      assert.equal(f.mockClear.length, 0)
      assert.equal(f.mockReturnValue.length, 1)
      assert.equal(f.withImplementation.length, 2)
      assert.equal(f.mockClear(), f)
      assert.equal(f.mockRestore(), undefined)
      assert.equal(f.getMockImplementation(), undefined)
    })

    test('the prototype`s own read gives the unbound method, whose call says what is wrong', () => {
      const { fn } = fnOf(policy)
      const proto = Object.getPrototypeOf(fn()) as { mockClear(): unknown; mock?: unknown }
      const unbound = proto.mockClear
      assert.equal(typeof unbound, 'function')
      assert.equal(proto.mockClear, unbound)
      assert.throws(() => unbound.call(undefined), {
        code: 'MOCK_DETACHED_METHOD',
        name: 'TypeError',
      })
    })

    test('assigning a method defines an own data property, and leaves other mocks alone', () => {
      const { fn } = fnOf(policy)
      const f = fn()
      const g = fn()
      const replacement = () => 'mine'
      ;(f as unknown as { mockClear: unknown }).mockClear = replacement
      assert.equal((f as unknown as { mockClear: unknown }).mockClear, replacement)
      assert.deepEqual(Object.getOwnPropertyDescriptor(f, 'mockClear'), {
        value: replacement,
        writable: true,
        enumerable: true,
        configurable: true,
      })
      assert.notEqual((g as unknown as { mockClear: unknown }).mockClear, replacement)
    })

    test('`for...in` lists the methods; the brand is an accessor that needs a slot', () => {
      const { fn } = fnOf(policy)
      const f = fn()
      const keys: string[] = []
      for (const key in f) keys.push(key)
      assert.ok(
        keys.includes('mockClear') && keys.includes('mock') && keys.includes('_isMockFunction'),
      )
      const proto = Object.getPrototypeOf(f) as object
      assert.equal(
        typeof Object.getOwnPropertyDescriptor(proto, '_isMockFunction')?.get,
        'function',
      )
      assert.equal(typeof Object.getOwnPropertyDescriptor(proto, MOCK_BRAND)?.get, 'function')
      assert.equal(typeof Object.getOwnPropertyDescriptor(proto, 'mockClear')?.get, 'function')
      assert.equal(f._isMockFunction, true)
      assert.equal((f as unknown as Record<symbol, unknown>)[MOCK_BRAND], true)
      assert.equal(Reflect.get(proto, '_isMockFunction'), undefined)
    })

    test('a Proxy around a mock keeps working', () => {
      const { fn } = fnOf(policy)
      const f = fn(() => 'impl')
      const proxy = new Proxy(f, {})
      assert.equal(proxy(), 'impl')
      proxy.mockReturnValue('stubbed')
      assert.equal(proxy(), 'stubbed')
      assert.equal(proxy.mock.calls.length, 2)
      assert.equal(proxy.mockClear, f.mockClear)
    })

    test('mockName sets and reset returns the default; length follows the implementation', () => {
      const { fn } = fnOf(policy)
      const f = fn()
      assert.equal(f.getMockName(), policy.defaultName)
      assert.equal(f.mockName('named'), f)
      assert.equal(f.getMockName(), 'named')
      f.mockReset()
      assert.equal(f.getMockName(), policy.defaultName)
      const arity = (a: unknown, b: unknown) => [a, b]
      assert.equal(fn(arity as UnknownFunction).length, 2)
      const many = (a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10) =>
        a + b + c + d + e + f + g + h + i + j
      assert.equal(fn(many as unknown as UnknownFunction).length, 10)
    })

    test('a declared arity still records every argument and `this`', () => {
      const { fn } = fnOf(policy)
      const f = fn(function (this: unknown, a: unknown) {
        return [this, a]
      } as UnknownFunction)
      const self = { f }
      assert.deepEqual(self.f(1, 2, 3), [self, 1])
      assert.deepEqual(f.mock.calls, [[1, 2, 3]])
      assert.deepEqual(f(), [undefined, undefined])
      assert.deepEqual(f.mock.calls[1], [])
    })
  })
}

describe('the policy keys', () => {
  test('neutral: the state object stays, in place, with lastCall and settledResults', async () => {
    const { fn } = fnOf(neutral)
    const f = fn(async () => 'value')
    const state = f.mock
    assert.deepEqual(Object.keys(state), [
      'calls',
      'contexts',
      'instances',
      'invocationCallOrder',
      'settledResults',
      'results',
      'lastCall',
    ])
    assert.equal(state.lastCall, undefined)
    await f(1)
    assert.deepEqual(state.lastCall, [1])
    assert.deepEqual(state.settledResults, [{ type: 'fulfilled', value: 'value' }])
    f.mockClear()
    assert.equal(f.mock, state)
    assert.equal(state.calls.length, 0)
    assert.deepEqual(state.settledResults, [])
    assert.throws(() => {
      ;(f as { mock: unknown }).mock = {}
    }, TypeError)
  })

  test('flipped: mockClear replaces the state object, and `lastCall` appears after a call', () => {
    const { fn } = fnOf(flipped)
    const f = fn()
    const state = f.mock
    assert.deepEqual(Object.keys(state), [
      'calls',
      'contexts',
      'instances',
      'invocationCallOrder',
      'results',
    ])
    assert.equal(f.mock, state)
    f(1)
    assert.deepEqual(f.mock.lastCall, [1])
    assert.deepEqual(Object.keys(f.mock).at(-1), 'lastCall')
    f.mockClear()
    assert.notEqual(f.mock, state)
    assert.equal(f.mock.calls.length, 0)
    const replacement = { calls: [['fake']] } as never
    ;(f as { mock: unknown }).mock = replacement
    assert.equal(f.mock, replacement)
  })

  test('resetTo: empty drops the implementation, original-impl returns to it', () => {
    const impl = () => 'orig'
    const emptied = fnOf(flipped).fn(impl).mockReturnValue('x').mockReset()
    assert.equal(emptied(), undefined)
    assert.equal(emptied.getMockImplementation(), undefined)
    const returned = fnOf(neutral).fn(impl).mockReturnValue('x').mockReset()
    assert.equal(returned(), 'orig')
    assert.equal(returned.getMockImplementation(), impl)
    const restored = fnOf(neutral).fn(impl).mockReturnValue('x')
    restored.mockRestore()
    assert.equal(restored(), 'orig')
  })

  test('functionName: the function`s own name, whatever the implementation`s', () => {
    function named() {}
    assert.equal(fnOf(flipped).fn().name, 'mockConstructor')
    assert.equal(fnOf(flipped).fn(named).name, 'mockConstructor')
    assert.equal(fnOf(neutral).fn().name, 'Mock')
  })

  test('newCall: apply runs an arrow on a fresh `this`; a class refuses', () => {
    const { fn } = fnOf(flipped)
    const Arrow = fn(() => {}) as unknown as new () => object
    const instance = new Arrow()
    assert.ok(instance instanceof Arrow)
    class Real {}
    const Wrapped = fn(Real as unknown as UnknownFunction) as unknown as new () => object
    assert.throws(() => new Wrapped(), /Class constructor Real/)
    const value = {}
    const ReturnsObject = fn().mockReturnValue(value) as unknown as new () => object
    assert.equal(new ReturnsObject(), value)
  })

  test('newCall: construct builds with new, and shorthands and arrows refuse', () => {
    const { fn } = fnOf(neutral)
    const warnings: unknown[] = []
    const { warn } = console
    console.warn = (text: unknown) => warnings.push(text)
    try {
      const Arrow = fn(() => {}) as unknown as new () => object
      assert.throws(() => new Arrow(), /is not a constructor/)
    } finally {
      console.warn = warn
    }
    assert.deepEqual(warnings, [], 'no dialect text, so no warning')
    class Real {
      value = 1
      method(): number {
        return this.value
      }
    }
    const Wrapped = fn(Real as unknown as UnknownFunction) as unknown as new () => Real
    const real = new Wrapped()
    assert.equal(real.method(), 1)
    assert.ok(real instanceof Real)
    assert.ok(real instanceof Wrapped)
    assert.equal((Wrapped as unknown as { mock: { instances: unknown[] } }).mock.instances[0], real)
    const Shorthand = fn().mockReturnValue(1) as unknown as new () => object
    assert.throws(() => new Shorthand(), { code: 'MOCK_NEW_SHORTHAND', name: 'TypeError' })
  })

  test('new-not-a-constructor warns when a policy has text for it', () => {
    const registry = createMockRegistry()
    const policy = { ...neutral, messages: { 'new-not-a-constructor': 'The {name} mock' } }
    const warnings: unknown[] = []
    const { warn } = console
    console.warn = (text: unknown) => warnings.push(text)
    try {
      const Arrow = createMockFn(policy, registry, {
        impl: () => {},
      }) as unknown as new () => object
      assert.throws(() => new Arrow(), TypeError)
    } finally {
      console.warn = warn
    }
    assert.deepEqual(warnings, ['The fn() mock'])
  })

  test('classMockPrototype: chain-to-impl follows the next implementation, own stays out of it', () => {
    function Base() {}
    Base.prototype.method = () => 'base'
    const chained = fnOf(neutral).fn(Base as UnknownFunction) as unknown as { prototype: object }
    assert.equal(Object.getPrototypeOf(chained.prototype), Base.prototype)
    ;(chained as unknown as { mockImplementation(f: unknown): void }).mockImplementation(() => {})
    assert.equal(Object.getPrototypeOf(chained.prototype), Object.prototype)
    const own = fnOf(flipped).fn(Base as UnknownFunction) as unknown as { prototype: object }
    assert.equal(Object.getPrototypeOf(own.prototype), Object.prototype)
  })

  test('chain-to-impl: an impl whose prototype has methods chains at creation', () => {
    function WithMethod(this: { value: number }) {
      this.value = 1
    }
    WithMethod.prototype.method = function (this: { value: number }) {
      return this.value
    }
    class Parent {
      inherited(): string {
        return 'parent'
      }
    }
    class Child extends Parent {}
    const M = fnOf(neutral).fn(WithMethod as UnknownFunction) as unknown as {
      new (): { method(): number }
      prototype: { method(): number }
    }
    assert.equal(Object.getPrototypeOf(M.prototype), WithMethod.prototype)
    assert.equal(M.prototype.method, WithMethod.prototype.method)
    assert.equal(new M().method(), 1)
    const C = fnOf(neutral).fn(Child as unknown as UnknownFunction) as unknown as {
      new (): Child
      prototype: Child
    }
    assert.equal(Object.getPrototypeOf(C.prototype), Child.prototype)
    assert.equal(typeof C.prototype.inherited, 'function')
    assert.equal(new C().inherited(), 'parent')
  })

  test('chain-to-impl: a prototype with nothing on it yet chains too, so a later key is seen', () => {
    function Plain(this: { value: number }) {
      this.value = 1
    }
    const M = fnOf(neutral).fn(Plain as UnknownFunction) as unknown as {
      new (): { value: number }
      prototype: object
    }
    assert.equal(Object.getPrototypeOf(M.prototype), Plain.prototype)
    ;(Plain.prototype as { late?: () => string }).late = () => 'late'
    assert.equal((M.prototype as { late?: () => string }).late?.(), 'late')
    const instance = new M()
    assert.equal(instance.value, 1)
    assert.ok(instance instanceof Plain)
    assert.ok(instance instanceof M)
  })

  test('fnOfMockReturnsSame and copyStaticProps', () => {
    const { fn } = fnOf(neutral)
    const inner = fn(() => 'inner')
    assert.equal(fn(inner), inner)
    const withStatic = Object.assign(() => 1, { extra: 'static' })
    assert.equal((fn(withStatic) as unknown as { extra: string }).extra, 'static')
    const other = fnOf(flipped)
    const wrapped = other.fn(other.fn(() => 'inner'))
    assert.equal(wrapped(), 'inner')
    assert.equal((other.fn(withStatic) as unknown as { extra?: string }).extra, undefined)
  })

  test('copyStaticProps walks the class chain and leaves the mock`s own methods alone', () => {
    class A {
      static inherited = 'a'
      instance = 1
    }
    class B extends A {
      static own(): string {
        return 'b'
      }
      static mockClear = 'a static with a method`s name'
    }
    const { fn } = fnOf(neutral)
    const mock = fn(B as unknown as UnknownFunction) as unknown as {
      inherited: string
      own(): string
      mockClear: unknown
    }
    assert.equal(mock.inherited, 'a')
    assert.equal(mock.own(), 'b')
    assert.equal(typeof mock.mockClear, 'function')
  })

  test('withImplementationReturnsMock and getImplPrefersOnce', async () => {
    const yes = fnOf(neutral).fn()
    assert.equal(
      yes.withImplementation(
        () => 1,
        () => {},
      ),
      yes,
    )
    assert.equal(
      await yes.withImplementation(
        () => 1,
        async () => {},
      ),
      yes,
    )
    const once = () => 'once'
    assert.equal(yes.mockImplementationOnce(once).getMockImplementation(), once)
    const no = fnOf(flipped).fn(() => 'kept')
    assert.equal(
      no.withImplementation(
        () => 1,
        () => {},
      ),
      undefined,
    )
    no.mockImplementationOnce(once)
    assert.notEqual(no.getMockImplementation(), once)
  })

  test('isMockAcceptsObjects', () => {
    const lookalike = { _isMockFunction: true }
    assert.equal(isMockFunction(flipped, lookalike), true)
    assert.equal(isMockFunction(neutral, lookalike), false)
    assert.equal(isMockFunction(flipped, undefined), false)
    assert.equal(
      isMockFunction(neutral, () => {}),
      false,
    )
  })
})

describe('createMockFn options', () => {
  test('name and length set the function`s own; fallback survives a reset', () => {
    const registry = createMockRegistry()
    const fallback = () => 'proto'
    const mock = createMockFn<UnknownFunction>(flipped, registry, {
      name: 'member',
      length: 3,
      fallback,
    })
    assert.equal(mock.name, 'member')
    assert.equal(mock.length, 3)
    assert.equal(mock(), 'proto')
    mock.mockReset()
    assert.equal(mock(), 'proto')
    mock.mockReturnValue('own')
    assert.equal(mock(), 'own')
  })
})

describe('createMockFn: original on its own', () => {
  for (const [name, policy] of policies) {
    test(`an anonymous original is called through (${name})`, () => {
      const registry = createMockRegistry()
      const anonymous = (
        () => () =>
          'real'
      )()
      const mock = createMockFn<UnknownFunction>(policy, registry, { original: anonymous })
      assert.equal(mock(), 'real')
      assert.equal(mock.mock.calls.length, 1)
    })
  }
})

describe('creation without code generation', () => {
  test('fn() and fn(impl) work under --disallow-code-generation-from-strings', () => {
    const fixture = fileURLToPath(new URL('./internal/no-codegen.fixture.ts', import.meta.url))
    // Both own names have their own makers.
    for (const [, policy] of policies) {
      const result = spawnSync(
        process.execPath,
        [
          ...process.execArgv,
          '--disallow-code-generation-from-strings',
          fixture,
          JSON.stringify(policy),
        ],
        { encoding: 'utf8', timeout: 30_000 },
      )
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /created/)
    }
  })

  test('the name and length stay exact, with no defineProperty on the way', () => {
    for (const [, policy] of policies) {
      const { fn } = fnOf(policy)
      const expected = policy.functionName === 'mockConstructor' ? 'mockConstructor' : 'Mock'
      for (let arity = 0; arity <= 9; arity++) {
        const impl = Object.defineProperty(() => undefined, 'length', { value: arity })
        const f = fn(impl as UnknownFunction)
        assert.equal(f.length, arity)
        assert.equal(f.name, expected)
      }
      const bare = fn()
      assert.equal(bare.length, 0)
      assert.equal(bare.name, expected)
      assert.deepEqual(Object.getOwnPropertyNames(bare).sort(), [
        'length',
        'mock',
        'name',
        'prototype',
      ])
    }
  })
})

for (const [name, policy] of policies) {
  describe(`review fixes (${name})`, () => {
    test('a bound mock is not a mock, and spyOn wraps it', () => {
      const { fn, registry } = fnOf(policy)
      const f = fn()
      const bound = f.bind(null)
      assert.equal(isMockFunction(policy, bound), false)
      assert.equal(Reflect.get(bound, MOCK_BRAND), undefined)
      assert.equal(isMockFunction(policy, f), true)
      assert.equal((Object.create(f) as { _isMockFunction: unknown })._isMockFunction, true)

      const target = { bar: bound as () => unknown }
      const spy = spyOn(policy, registry, target, 'bar')
      assert.notEqual(spy, bound)
      spy.mockReturnValue('stubbed')
      assert.equal(target.bar(), 'stubbed')
    })

    test('_isMockFunction can be assigned, and the assignment is an own property', () => {
      const { fn } = fnOf(policy)
      const f = fn()
      ;(f as unknown as { _isMockFunction: unknown })._isMockFunction = false
      assert.equal(f._isMockFunction, false)
      assert.equal(Object.hasOwn(f, '_isMockFunction'), true)
      assert.equal(fn()._isMockFunction, true)
    })

    test('withImplementation does not revive an implementation a reset took away', async () => {
      const { fn, registry } = fnOf(policy)
      const sync = fn()
      sync.mockReturnValue('orig')
      sync.mockReturnValueOnce('once')
      sync.withImplementation(
        () => 'tmp',
        () => {
          sync.mockReset()
        },
      )
      assert.equal(sync(), undefined)
      assert.equal(sync(), undefined)

      const all = fn()
      all.mockReturnValue('orig')
      all.withImplementation(
        () => 'tmp',
        () => {
          registry.resetAll()
        },
      )
      assert.equal(all(), undefined)

      const later = fn()
      later.mockReturnValue('orig')
      let release: () => void = () => {}
      const pending = later.withImplementation(
        () => 'tmp',
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          }),
      )
      registry.resetAll()
      release()
      await pending
      assert.equal(later(), undefined)
    })

    test('withImplementation still restores after a mockClear', () => {
      const { fn } = fnOf(policy)
      const f = fn()
      f.mockReturnValue('orig')
      f.withImplementation(
        () => 'tmp',
        () => {
          assert.equal(f(), 'tmp')
          f.mockClear()
        },
      )
      assert.equal(f(), 'orig')
    })

    test('a queued undefined falls back to the implementation on a plain call', () => {
      const { fn } = fnOf(policy)
      const f = fn()
      f.mockReturnValue(7)
      f.mockImplementationOnce(undefined as unknown as UnknownFunction)
      assert.equal(f(), 7)
      assert.equal(f(), 7)
      const g = fn()
      g.mockReturnValue(7)
      g.mockImplementationOnce(null as unknown as UnknownFunction)
      assert.equal(g(), undefined)
      assert.equal(g(), 7)
    })

    test('under new, a queued undefined runs nothing', () => {
      const { fn } = fnOf(policy)
      const f = fn()
      f.mockImplementation(function (this: { v?: number }) {
        this.v = 7
      })
      f.mockImplementationOnce(undefined as unknown as UnknownFunction)
      const first = new (f as unknown as new () => { v?: number })()
      assert.equal(first.v, undefined)
      const second = new (f as unknown as new () => { v?: number })()
      assert.equal(second.v, 7)
    })

    test('whenCalledWith falls through for an undefined implementation, not for null', () => {
      const { fn } = fnOf(policy)
      const f = fn()
      f.mockImplementation(() => 'fb')
      const branch = f.whenCalledWith(1)
      branch.mockImplementation(() => 'a')
      assert.equal(f(1), 'a')
      branch.mockImplementation(undefined as unknown as UnknownFunction)
      assert.equal(f(1), 'fb')
      branch.mockImplementation(null as unknown as UnknownFunction)
      assert.equal(f(1), undefined)
      assert.equal(f(2), 'fb')
    })

    test('creating and calling a mock does not read Array.prototype.slice or Function.prototype.call', () => {
      const { fn, registry } = fnOf(policy)
      for (const key of ['slice', 'call'] as const) {
        const subject = key === 'slice' ? Array.prototype : Function.prototype
        const spy = spyOn(policy, registry, subject as never, key as never) as unknown as {
          mockRestore(): void
          mock: { calls: unknown[][] }
        }
        let calls: unknown[][] = []
        let recorded: unknown[][] = []
        try {
          const g = fn()
          g(1, 2)
          recorded = g.mock.calls
          calls = spy.mock.calls
        } finally {
          spy.mockRestore()
        }
        assert.deepEqual(recorded, [[1, 2]])
        assert.equal(calls.length, 0)
      }
    })

    test('reading a method does not go through Function.prototype.bind', () => {
      const { fn, registry } = fnOf(policy)
      const spy = spyOn(
        policy,
        registry,
        Function.prototype as never,
        'bind' as never,
      ) as unknown as {
        mockRestore(): void
        mock: { calls: unknown[][] }
      }
      let count = -1
      try {
        const f = fn()
        void f.mockClear
        void f.mockReturnValue
        count = spy.mock.calls.length
      } finally {
        spy.mockRestore()
      }
      assert.equal(count, 0)
    })
  })
}

describe('review fixes: state edges', () => {
  test('a mock whose .mock was assigned undefined recovers on the next call', () => {
    const { fn } = fnOf(flipped)
    const f = fn()
    ;(f as unknown as { mock: unknown }).mock = undefined
    f(1)
    assert.deepEqual(f.mock.calls, [[1]])
    ;(f as unknown as { mock: unknown }).mock = null
    f(2)
    assert.deepEqual(f.mock.calls, [[2]])
  })

  test('newCall: construct writes the instance into the arrays current after a mockClear, as @vitest/spy does', () => {
    const { fn } = fnOf(neutral)
    let clear = true
    const f = fn(function (this: { x?: number }) {
      if (clear) f.mockClear()
      this.x = 1
    })
    const instance = new (f as unknown as new (arg: number) => unknown)(1)
    clear = false
    assert.deepEqual(f.mock.calls, [])
    assert.deepEqual(f.mock.results, [])
    assert.deepEqual(f.mock.contexts, [instance])
    assert.deepEqual(f.mock.instances, [instance])
  })

  test('newCall: construct writes nothing for a construction that throws, and a plain call never writes', () => {
    const { fn } = fnOf(neutral)
    const boom = fn(() => {
      throw new Error('boom')
    })
    assert.throws(() => new (boom as unknown as new () => unknown)())
    assert.deepEqual(boom.mock.instances, [undefined])
    assert.deepEqual(boom.mock.contexts, [undefined])
    const plain = fn(() => 1)
    const self = { plain }
    self.plain()
    assert.deepEqual(plain.mock.contexts, [self])
    assert.deepEqual(plain.mock.instances, [self])
  })

  test('a spy under a bridge policy loses its call-through with mockImplementation(undefined)', () => {
    const target = { m: (value: string) => `original:${value}` }
    for (const [policy, calls] of [
      [flipped, false],
      [neutral, true],
    ] as const) {
      const registry = createMockRegistry()
      const subject = { ...target }
      const spy = spyOn(policy, registry, subject, 'm')
      spy.mockReturnValue('stubbed')
      assert.equal(subject.m('x'), 'stubbed')
      spy.mockImplementation(undefined as never)
      assert.equal(subject.m('x'), calls ? 'original:x' : undefined)
      if (!calls) assert.equal(spy.getMockImplementation(), undefined)
      spy.mockReset()
      assert.equal(subject.m('x'), calls ? 'original:x' : undefined)
    }
  })
})
