import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ModuleRef } from '@provino/types'
import { forEachModuleRef, isImportableLocation, moduleRef } from './module-ref.ts'

describe('isImportableLocation', () => {
  test('accepts an absolute path and any URL', () => {
    for (const location of [
      '/project/x.ts',
      'file:///project/x.ts',
      'data:text/javascript,export{}',
      'node:path',
    ]) {
      assert.equal(isImportableLocation(location), true, location)
    }
  })

  test('refuses a bare specifier, a relative path and the empty string', () => {
    for (const location of ['@provino/policy', 'pkg', './x.ts', '../x.ts', 'nested/x.ts', '']) {
      assert.equal(isImportableLocation(location), false, location)
    }
  })
})

describe('forEachModuleRef', () => {
  function collect(value: unknown, path = 'policy'): [string, ModuleRef][] {
    const found: [string, ModuleRef][] = []
    forEachModuleRef(value, path, (ref, at) => found.push([at, ref]))
    return found
  }

  test('visits each ref with a dotted key path and indexed array items', () => {
    const a = moduleRef('/a.ts', 'a')
    const b = moduleRef('/b.ts', 'b')
    const c = moduleRef('/c.ts', 'c')
    const found = collect({ core: { a }, list: [{ b }, c], n: 1, s: 'x', none: null })
    assert.deepEqual(found, [
      ['policy.core.a', a],
      ['policy.list[0].b', b],
      ['policy.list[1]', c],
    ])
  })

  test('visits a ref given at the top, and does not search inside a ref', () => {
    const ref = moduleRef('/a.ts', 'a')
    assert.deepEqual(collect(ref, 'globals'), [['globals', ref]])
    assert.deepEqual(collect({ factory: ref }, ''), [['.factory', ref]])
  })

  test('survives a cycle, visiting a shared object once', () => {
    const ref = moduleRef('/a.ts', 'a')
    const cyclic: Record<string, unknown> = { ref }
    cyclic.self = cyclic
    assert.deepEqual(collect(cyclic), [['policy.ref', ref]])
    const shared = { ref }
    assert.equal(collect({ x: shared, y: shared }).length, 1)
  })

  test('uses the guard it is given, and may visit a non-ref', () => {
    const loose = { module: 1, export: 'x', extra: true }
    const found: unknown[] = []
    forEachModuleRef(
      { a: loose, b: () => 1, c: { deep: 1 } },
      'p',
      (ref, at) => found.push([at, ref]),
      (value): value is object =>
        typeof value === 'function' ||
        (typeof value === 'object' && value !== null && 'module' in value),
    )
    assert.equal(found.length, 2)
    assert.deepEqual((found[0] as [string, unknown])[0], 'p.a')
    assert.deepEqual((found[1] as [string, unknown])[0], 'p.b')
  })

  test('lets a visitor throw to stop the walk', () => {
    assert.throws(
      () =>
        forEachModuleRef({ a: moduleRef('/a.ts', 'a') }, 'p', (_ref, at) => {
          throw new Error(at)
        }),
      { message: 'p.a' },
    )
  })
})
