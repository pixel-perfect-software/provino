import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import type { MockPolicy } from '@provino/types'
import { flipped, neutral, policies } from './internal/test-support.ts'
import { createMockFn } from './mock-fn.ts'
import { createMockRegistry } from './registry.ts'
import { spyOn } from './spy.ts'
import { createStubs } from './stubs.ts'

for (const [name, policy] of policies) {
  describe(`the dirty sets (${name})`, () => {
    test('creation touches neither set; a call or a config change joins one', () => {
      const registry = createMockRegistry()
      const bare = createMockFn(policy, registry)
      const withImpl = createMockFn(policy, registry, { impl: () => 1 })
      assert.deepEqual(registry.dirtyCounts(), { state: 0, config: 0 })
      bare()
      assert.deepEqual(registry.dirtyCounts(), { state: 1, config: 0 })
      withImpl.mockReturnValue(2)
      assert.deepEqual(registry.dirtyCounts(), { state: 1, config: 1 })
    })

    test('clearAll clears what was called and leaves implementations', () => {
      const registry = createMockRegistry()
      const f = createMockFn(policy, registry, { impl: () => 'impl' })
      f()
      registry.clearAll()
      assert.equal(f.mock.calls.length, 0)
      assert.equal(f(), 'impl')
      assert.equal(f.mock.calls.length, 1, 'it joins again on its next call')
      registry.clearAll()
      assert.equal(f.mock.calls.length, 0)
    })

    test('a dropped mock can be collected, and the next walk forgets it', async () => {
      setFlagsFromString('--expose-gc')
      const gc = runInNewContext('gc') as () => void
      const registry = createMockRegistry()
      let held: WeakRef<object> | undefined
      ;(() => {
        const f = createMockFn(policy, registry)
        f()
        held = new WeakRef(f)
      })()
      for (let round = 0; round < 10 && held?.deref() !== undefined; round++) {
        await new Promise((resolve) => setImmediate(resolve))
        gc()
      }
      assert.equal(held?.deref(), undefined, 'the registry holds it only weakly')
      assert.equal(registry.dirtyCounts().state, 1)
      registry.clearAll()
      assert.equal(registry.dirtyCounts().state, 0)
    })

    test('dispose restores spies and unstubs, once, and drops everything', () => {
      const registry = createMockRegistry()
      const env: Record<string, string | undefined> = { KEPT: 'kept' }
      const stubs = createStubs(registry, env, {})
      const original = () => 'original'
      const target = { method: original }
      spyOn(policy, registry, target, 'method')
      stubs.stubEnv('KEPT', 'changed')
      createMockFn(policy, registry)()
      registry.dispose()
      assert.equal(target.method, original)
      assert.equal(env.KEPT, 'kept')
      assert.deepEqual(registry.dirtyCounts(), { state: 0, config: 0 })
      registry.dispose()
    })

    test('every restorer runs even when one throws, and the error is rethrown', () => {
      const registry = createMockRegistry()
      const first = { method: () => 1 }
      const second = { method: () => 2 }
      const originalSecond = second.method
      spyOn(policy, registry, first, 'method')
      spyOn(policy, registry, second, 'method')
      Object.freeze(first)
      assert.throws(() => registry.restoreAll(), TypeError)
      assert.equal(second.method, originalSecond)
      registry.restoreAll()
    })
  })
}

describe('what the sets must not miss', () => {
  test('clearReplacesStateObject: a never-called mock whose `.mock` was read gets a new one', () => {
    const registry = createMockRegistry()
    const f = createMockFn(flipped, registry)
    assert.deepEqual(registry.dirtyCounts(), { state: 0, config: 0 })
    const before = f.mock
    assert.equal(registry.dirtyCounts().state, 1)
    registry.clearAll()
    assert.notEqual(f.mock, before)
  })

  test('without it, reading `.mock` joins nothing and identity holds', () => {
    const registry = createMockRegistry()
    const f = createMockFn(neutral, registry)
    const before = f.mock
    assert.equal(registry.dirtyCounts().state, 0)
    registry.clearAll()
    assert.equal(f.mock, before)
  })

  test('resetTo: empty reaches an `fn(impl)` nothing has touched', () => {
    const registry = createMockRegistry()
    const f = createMockFn(flipped, registry, { impl: () => 'impl' })
    registry.resetAll()
    assert.equal(f.getMockImplementation(), undefined)
    assert.equal(f(), undefined)
    const g = createMockFn(flipped, registry, { impl: () => 'impl' })
    registry.resetAll()
    g.mockImplementationOnce(() => 'once')
    assert.equal(g(), 'once')
    assert.equal(g(), undefined)
  })

  test('a mock made after a resetAll keeps its implementation', () => {
    const registry = createMockRegistry()
    registry.resetAll()
    const f = createMockFn(flipped, registry, { impl: () => 'impl' })
    assert.equal(f(), 'impl')
  })

  test('an implementation set after a resetAll survives the catch-up', () => {
    const registry = createMockRegistry()
    const f = createMockFn(flipped, registry, { impl: () => 'first' })
    registry.resetAll()
    f.mockImplementation(() => 'second')
    assert.equal(f(), 'second')
  })

  test('resetTo: original-impl keeps it', () => {
    const registry = createMockRegistry()
    const f = createMockFn(neutral, registry, { impl: () => 'impl' })
    registry.resetAll()
    assert.equal(f(), 'impl')
  })

  test('resetAll reaches a mock with state only, config only, and both', () => {
    const registry = createMockRegistry()
    const stateOnly = createMockFn(flipped, registry, { impl: () => 'a' })
    const configOnly = createMockFn(flipped, registry)
    const both = createMockFn(flipped, registry)
    stateOnly()
    configOnly.mockReturnValue('b')
    both.mockReturnValue('c')
    both()
    registry.resetAll()
    assert.deepEqual(registry.dirtyCounts(), { state: 0, config: 0 })
    assert.equal(stateOnly(), undefined)
    assert.equal(configOnly(), undefined)
    assert.equal(both(), undefined)
    assert.equal(both.mock.calls.length, 1)
  })

  test('the invocation counter is the registry`s, across files', () => {
    const one = createMockRegistry()
    const two = createMockRegistry()
    const a = createMockFn(neutral, one)
    const b = createMockFn(neutral, two)
    a()
    a()
    b()
    assert.deepEqual(a.mock.invocationCallOrder, [1, 2])
    assert.deepEqual(b.mock.invocationCallOrder, [1])
  })
})

describe('beforeEach', () => {
  const trace = (
    policy: MockPolicy,
    cfg: Parameters<ReturnType<typeof createMockRegistry>['beforeEach']>[0],
  ) => {
    const registry = createMockRegistry()
    const steps: string[] = []
    const spied = registry as unknown as Record<string, () => void>
    for (const method of ['clearAll', 'resetAll', 'restoreAll']) {
      const original = spied[method]?.bind(registry)
      spied[method] = () => {
        steps.push(method)
        original?.()
      }
    }
    registry.beforeEach(cfg, policy.between)
    return steps
  }

  test('steps run in the policy`s order, on the policy`s default flags', () => {
    assert.deepEqual(trace(neutral, {}), ['restoreAll', 'clearAll'])
    assert.deepEqual(trace(flipped, {}), [])
  })

  test('the config overrides a default, either way', () => {
    assert.deepEqual(trace(neutral, { clear: false, restore: false }), [])
    assert.deepEqual(trace(flipped, { clear: true, reset: true, restore: true }), [
      'clearAll',
      'resetAll',
      'restoreAll',
    ])
    assert.deepEqual(trace(neutral, { reset: true, clear: true, restore: true }), [
      'restoreAll',
      'resetAll',
      'clearAll',
    ])
  })

  test('a step the order leaves out never runs, whatever the config', () => {
    const registry = createMockRegistry()
    const env: Record<string, string | undefined> = {}
    createStubs(registry, env, {}).stubEnv('A', 'stubbed')
    registry.beforeEach({ unstubEnvs: true }, flipped.between)
    assert.equal(env.A, 'stubbed')
    registry.beforeEach({ unstubEnvs: true }, neutral.between)
    assert.equal(env.A, undefined)
  })

  test('the unstub steps reach both stub kinds', () => {
    const registry = createMockRegistry()
    const global: Record<string, unknown> = {}
    createStubs(registry, {}, global).stubGlobal('A', 1)
    assert.equal(global.A, 1)
    registry.beforeEach({ unstubGlobals: true }, neutral.between)
    assert.equal('A' in global, false)
  })
})
