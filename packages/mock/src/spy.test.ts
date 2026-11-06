import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { flipped, neutral, policies } from './internal/test-support.ts'
import { createMockFn } from './mock-fn.ts'
import { createMockRegistry } from './registry.ts'
import { replaceProperty, spyOn } from './spy.ts'
import { createStubs } from './stubs.ts'

const make = () => ({
  method(a: string): string {
    return `original:${a}`
  },
})

for (const [name, policy] of policies) {
  describe(`spyOn (${name})`, () => {
    test('installs a mock that calls through, and restores', () => {
      const registry = createMockRegistry()
      const target = make()
      const original = target.method
      const spy = spyOn(policy, registry, target, 'method')
      assert.equal(target.method, spy)
      assert.equal(target.method('x'), 'original:x')
      assert.deepEqual(spy.mock.calls, [['x']])
      spy.mockRestore()
      assert.equal(target.method, original)
    })

    test('a second spyOn returns the same spy', () => {
      const registry = createMockRegistry()
      const target = make()
      assert.equal(
        spyOn(policy, registry, target, 'method'),
        spyOn(policy, registry, target, 'method'),
      )
    })

    test('restoreAll puts the property back and keeps the spy`s state and implementation', () => {
      const registry = createMockRegistry()
      const target = make()
      const original = target.method
      const spy = spyOn(policy, registry, target, 'method')
      spy.mockReturnValue('stubbed')
      target.method('a')
      registry.restoreAll()
      assert.equal(target.method, original)
      assert.equal(spy.mock.calls.length, 1)
      assert.equal(spy('b' as never), 'stubbed')
    })

    test('a frozen object: the throw, and restoreAll still works (DV7)', () => {
      const registry = createMockRegistry()
      const fine = make()
      const fineOriginal = fine.method
      spyOn(policy, registry, fine, 'method')
      const frozen = Object.freeze(make())
      const before = frozen.method
      assert.throws(() => spyOn(policy, registry, frozen, 'method'), TypeError)
      assert.equal(frozen.method, before)
      assert.doesNotThrow(() => registry.restoreAll())
      assert.equal(fine.method, fineOriginal)
    })

    test('an inherited method: own while spied, deleted on restore', () => {
      class Base {
        method(): string {
          return 'base'
        }
      }
      const child = new (class extends Base {})()
      const registry = createMockRegistry()
      const spy = spyOn(policy, registry, child, 'method')
      assert.equal(Object.hasOwn(child, 'method'), true)
      assert.equal(child.method(), 'base')
      spy.mockRestore()
      assert.equal(Object.hasOwn(child, 'method'), false)
      assert.equal(child.method(), 'base')
    })

    test('accessors: get and set spies call through, record and restore', () => {
      let stored = 'initial'
      const target = {
        get value(): string {
          return stored
        },
        set value(next: string) {
          stored = next
        },
      }
      const registry = createMockRegistry()
      const getter = spyOn(policy, registry, target, 'value', 'get')
      assert.equal(target.value, 'initial')
      assert.equal(getter.mock.calls.length, 1)
      getter.mockReturnValue('stubbed')
      assert.equal(target.value, 'stubbed')
      getter.mockRestore()
      assert.equal(target.value, 'initial')

      const setter = spyOn(policy, registry, target, 'value', 'set')
      target.value = 'assigned'
      assert.deepEqual(setter.mock.calls, [['assigned']])
      assert.equal(stored, 'assigned')
      setter.mockRestore()
      target.value = 'after'
      assert.equal(setter.mock.calls.length, 0)
      assert.equal(stored, 'after')
    })

    test('an inherited accessor: its own copy is deleted on restore', () => {
      class Base {
        get value(): string {
          return 'base'
        }
      }
      const child = new (class extends Base {})()
      const registry = createMockRegistry()
      const spy = spyOn(policy, registry, child, 'value', 'get')
      assert.equal(Object.hasOwn(child, 'value'), true)
      assert.equal(child.value, 'base')
      spy.mockRestore()
      assert.equal(Object.hasOwn(child, 'value'), false)
    })

    test('an ESM-namespace getter (the Vite SSR rule): spied through it, restored to it', () => {
      const implementation = () => 'real'
      const getter = () => implementation
      const namespace = {} as { exported: () => string }
      Object.defineProperty(namespace, 'exported', {
        enumerable: true,
        configurable: true,
        get: getter,
      })
      const registry = createMockRegistry()
      const spy = spyOn(policy, registry, namespace, 'exported')
      assert.equal(namespace.exported, spy)
      assert.equal(namespace.exported(), 'real')
      spy.mockReturnValue('stubbed')
      assert.equal(namespace.exported(), 'stubbed')
      const descriptor = Object.getOwnPropertyDescriptor(namespace, 'exported')
      assert.equal(typeof descriptor?.get, 'function')
      assert.equal(descriptor?.enumerable, true)
      registry.restoreAll()
      assert.equal(Object.getOwnPropertyDescriptor(namespace, 'exported')?.get, getter)
      assert.equal(namespace.exported, implementation)
    })

    test('a spy on a mock`s own method calls through, is restorable, and leaves the mock working', () => {
      const registry = createMockRegistry()
      const mock = createMockFn(policy, registry)
      mock()
      const inherited = mock.mockClear
      const spy = spyOn(policy, registry, mock, 'mockClear')
      assert.equal(mock.mockClear, spy)
      assert.equal(Object.getOwnPropertyDescriptor(mock, 'mockClear')?.configurable, true)
      mock.mockClear()
      assert.equal(spy.mock.calls.length, 1)
      assert.equal(mock.mock.calls.length, 0, 'it called through')
      spy.mockRestore()
      assert.equal(Object.hasOwn(mock, 'mockClear'), false)
      assert.equal(mock.mockClear, inherited)
      assert.equal(mock.mockClear(), mock)
    })

    test('restoreAll undoes a spy on a mock`s own method', () => {
      const registry = createMockRegistry()
      const mock = createMockFn(policy, registry)
      const inherited = mock.mockReturnValue
      spyOn(policy, registry, mock, 'mockReturnValue')
      registry.restoreAll()
      assert.equal(mock.mockReturnValue, inherited)
    })

    test('replaceProperty refuses a mock`s method, as any function', () => {
      const registry = createMockRegistry()
      const mock = createMockFn(policy, registry) as unknown as { mockClear: unknown }
      assert.throws(() => replaceProperty(policy, registry, mock, 'mockClear', 1), {
        code: 'MOCK_REPLACE_FUNCTION',
      })
    })

    test('Symbol.dispose restores', () => {
      const registry = createMockRegistry()
      const target = make()
      const original = target.method
      // Called directly: `using` isn't syntax on Node 22, which CI runs.
      const spy = spyOn(policy, registry, target, 'method')
      assert.equal(target.method, spy)
      spy[Symbol.dispose]()
      assert.equal(target.method, original)
    })
  })

  describe(`replaceProperty and stubs (${name})`, () => {
    test('replaceProperty replaces, replaces again and restores', () => {
      const registry = createMockRegistry()
      const target = { value: 1 }
      const replaced = replaceProperty(policy, registry, target, 'value', 2)
      assert.equal(target.value, 2)
      assert.equal(replaced.replaceValue(3), replaced)
      assert.equal(target.value, 3)
      assert.equal(replaceProperty(policy, registry, target, 'value', 4), replaced)
      replaced.restore()
      assert.equal(target.value, 1)
      registry.restoreAll()
      assert.equal(target.value, 1)
    })

    test('restoreAll reaches a replaced property; an inherited one is deleted', () => {
      const registry = createMockRegistry()
      const target = Object.create({ value: 1 }) as { value: number }
      replaceProperty(policy, registry, target, 'value', 2)
      assert.equal(Object.hasOwn(target, 'value'), true)
      registry.restoreAll()
      assert.equal(Object.hasOwn(target, 'value'), false)
    })

    test('a failed first write leaves nothing registered', () => {
      const registry = createMockRegistry()
      const target = {} as { value: number }
      Object.defineProperty(target, 'value', { value: 1, writable: false, configurable: true })
      assert.throws(() => replaceProperty(policy, registry, target, 'value', 2), TypeError)
      assert.doesNotThrow(() => registry.restoreAll())
    })

    test('stubEnv and unstubAllEnvs: the value from before the first stub', () => {
      const env: Record<string, string | undefined> = { SET: 'original' }
      const stubs = createStubs(createMockRegistry(), env, {})
      assert.equal(stubs.stubEnv('SET', 'a'), stubs)
      stubs.stubEnv('SET', 'b').stubEnv('NEW', 'c').stubEnv('GONE', undefined)
      assert.deepEqual({ ...env }, { SET: 'b', NEW: 'c' })
      stubs.stubEnv('NUMBER', 5 as never)
      assert.equal(env.NUMBER, '5')
      stubs.unstubAllEnvs()
      assert.deepEqual({ ...env }, { SET: 'original' })
    })

    test('stubGlobal and unstubAllGlobals: the descriptor from before the first stub', () => {
      const global: Record<string, unknown> = {}
      Object.defineProperty(global, 'hidden', { value: 1, configurable: true })
      const stubs = createStubs(createMockRegistry(), {}, global)
      stubs.stubGlobal('hidden', 2).stubGlobal('hidden', 3).stubGlobal('fresh', 4)
      assert.equal(global.hidden, 3)
      assert.equal(Object.getOwnPropertyDescriptor(global, 'hidden')?.enumerable, true)
      stubs.unstubAllGlobals()
      assert.equal(global.hidden, 1)
      assert.equal(Object.getOwnPropertyDescriptor(global, 'hidden')?.enumerable, false)
      assert.equal('fresh' in global, false)
    })
  })
}

describe('assign flow: checks and coded errors', () => {
  const registry = createMockRegistry()

  test('a primitive, no key, a missing key (with the policy`s text)', () => {
    assert.throws(() => spyOn(flipped, registry, 1 as never, 'x' as never), {
      code: 'MOCK_SPY_PRIMITIVE',
      name: 'Error',
      message: 'Cannot spy on a primitive value; number given',
    })
    assert.throws(() => spyOn(flipped, registry, {}, undefined as never), {
      code: 'MOCK_SPY_NO_KEY',
    })
    assert.throws(() => spyOn(flipped, registry, {}, 'nope' as never), {
      code: 'MOCK_SPY_MISSING',
      name: 'Error',
      message: 'flipped text for `nope`',
    })
  })

  test('not a function: a TypeError, with the hint for a non-object', () => {
    assert.throws(() => spyOn(flipped, registry, { a: 1 }, 'a' as never), {
      code: 'MOCK_SPY_NOT_A_FUNCTION_PRIMITIVE',
      name: 'TypeError',
    })
    assert.throws(() => spyOn(flipped, registry, { a: {} }, 'a' as never), {
      code: 'MOCK_SPY_NOT_A_FUNCTION',
      name: 'TypeError',
    })
  })

  test('accessors: the access type and configurability are checked', () => {
    const target = {
      get readonly(): number {
        return 1
      },
    }
    assert.throws(() => spyOn(flipped, registry, target, 'readonly', 'set'), {
      code: 'MOCK_SPY_NO_ACCESS_TYPE',
    })
    const locked = {} as { locked: number }
    Object.defineProperty(locked, 'locked', { get: () => 1, configurable: false })
    assert.throws(() => spyOn(flipped, registry, locked, 'locked', 'get'), {
      code: 'MOCK_SPY_NOT_CONFIGURABLE',
    })
    assert.throws(() => spyOn(flipped, registry, {} as { x: 1 }, 'x', 'get'), {
      code: 'MOCK_SPY_MISSING',
    })
  })

  test('a read-only property: V8`s own error, or the policy`s `spy-read-only` text', () => {
    const frozen = Object.freeze(make())
    assert.throws(() => spyOn(flipped, createMockRegistry(), frozen, 'method'), {
      name: 'TypeError',
      message: "Cannot assign to read only property 'method' of object '#<Object>'",
    })
    const policy = {
      ...flipped,
      messages: { 'spy-read-only': "Read-only '{key}' of '{tag}'" },
    }
    const registry = createMockRegistry()
    assert.throws(() => spyOn(policy, registry, frozen, 'method'), {
      name: 'TypeError',
      code: 'MOCK_SPY_READ_ONLY',
      message: "Read-only 'method' of '[object Object]'",
    })
    assert.doesNotThrow(() => registry.restoreAll())
  })

  test('a class spied through its bridge refuses `new`', () => {
    class Klass {}
    const ns = { Klass }
    const spy = spyOn(flipped, createMockRegistry(), ns, 'Klass')
    assert.throws(() => new spy(), /Class constructor Klass/)
  })

  test('reset leaves the spy installed and empty; the bridge is what it reports', () => {
    const target = make()
    const spy = spyOn(flipped, createMockRegistry(), target, 'method')
    const bridge = spy.getMockImplementation()
    assert.notEqual(bridge, undefined)
    assert.equal(bridge?.('x'), 'original:x')
    spy.mockReset()
    assert.equal(target.method, spy)
    assert.equal(target.method('x'), undefined)
    assert.equal(spy.getMockName(), flipped.defaultName)
  })

  test('resetAll reaches a spy nothing has called', () => {
    const registry = createMockRegistry()
    const target = make()
    spyOn(flipped, registry, target, 'method')
    registry.resetAll()
    assert.equal(target.method('x'), undefined)
  })
})

describe('replaceProperty: checks', () => {
  const registry = createMockRegistry()
  const accessor = {
    get got(): number {
      return 1
    },
    set put(_value: number) {},
    fn(): void {},
  }

  test('each refusal has its code and class', () => {
    assert.throws(() => replaceProperty(flipped, registry, 1 as never, 'x' as never, 1 as never), {
      code: 'MOCK_REPLACE_PRIMITIVE',
    })
    assert.throws(() => replaceProperty(flipped, registry, {}, undefined as never, 1 as never), {
      code: 'MOCK_REPLACE_NO_KEY',
    })
    assert.throws(() => replaceProperty(flipped, registry, {}, 'nope' as never, 1 as never), {
      code: 'MOCK_REPLACE_MISSING',
    })
    assert.throws(() => replaceProperty(flipped, registry, Object.freeze({ a: 1 }), 'a', 1), {
      code: 'MOCK_REPLACE_NOT_CONFIGURABLE',
    })
    assert.throws(() => replaceProperty(flipped, registry, accessor, 'got', 2), {
      code: 'MOCK_REPLACE_GETTER',
    })
    assert.throws(() => replaceProperty(flipped, registry, accessor, 'put', 2), {
      code: 'MOCK_REPLACE_SETTER',
    })
    assert.throws(() => replaceProperty(flipped, registry, accessor, 'fn', () => {}), {
      code: 'MOCK_REPLACE_FUNCTION',
      name: 'TypeError',
    })
  })
})

describe('define flow', () => {
  test('its checks and coded errors', () => {
    const registry = createMockRegistry()
    assert.throws(() => spyOn(neutral, registry, undefined as never, 'x' as never), {
      code: 'MOCK_SPY_NULLISH',
    })
    assert.throws(() => spyOn(neutral, registry, 1 as never, 'x' as never), {
      code: 'MOCK_SPY_DEFINE_PRIMITIVE',
    })
    assert.throws(() => spyOn(neutral, registry, {}, 'nope' as never), {
      code: 'MOCK_SPY_DEFINE_MISSING',
      message: 'The property "nope" is not defined on the object',
    })
    assert.throws(() => spyOn(neutral, registry, { a: 1 }, 'a' as never), {
      code: 'MOCK_SPY_DEFINE_NOT_A_FUNCTION',
      name: 'Error',
    })
  })

  test('a non-configurable property: defineProperty`s own error', () => {
    const registry = createMockRegistry()
    const locked = {} as { locked: number }
    Object.defineProperty(locked, 'locked', { get: () => 1, configurable: false })
    assert.throws(
      () => spyOn(neutral, registry, locked, 'locked', 'get'),
      /Cannot redefine property/,
    )
    assert.doesNotThrow(() => registry.restoreAll())
  })

  test('a namespace object refuses with the namespace message and a cause', () => {
    const registry = createMockRegistry()
    const namespace = Object.freeze({
      exported: () => 1,
      [Symbol.toStringTag]: 'Module',
    })
    assert.throws(() => spyOn(neutral, registry, namespace, 'exported'), {
      code: 'MOCK_SPY_NAMESPACE',
      name: 'TypeError',
    })
  })

  test('a class spied through keeps constructing; reset calls the original again', () => {
    class Klass {
      value = 'real'
    }
    const ns = { Klass }
    const spy = spyOn(neutral, createMockRegistry(), ns, 'Klass')
    assert.equal(new spy().value, 'real')
    assert.equal(spy.name, 'Klass')
    assert.equal(spy.getMockName(), 'Klass')
    assert.equal(spy.getMockImplementation(), undefined)
    spy.mockReset()
    assert.equal(new spy().value, 'real')
    assert.equal(spy.getMockName(), 'Klass')
  })

  test('a setter spied where there is none: installed, with the key put back on restore', () => {
    const registry = createMockRegistry()
    const target = { plain: 'data' }
    const spy = spyOn(neutral, registry, target, 'plain', 'get')
    assert.equal(target.plain, undefined)
    assert.equal(spy.mock.calls.length, 1)
    registry.restoreAll()
    assert.equal(target.plain, 'data')
  })
})
