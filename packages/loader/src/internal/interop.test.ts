// The interop contract (B13c Gap 3), as B13b's fake loader held it against the mod-corpus goldens:
// Jest 30.5 is `babel`, Vitest 5.0 is `node`. Each rule below is one the goldens force.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actualView, cjsNamespace, createInteropCache, esmExports, isNamespace } from './interop.ts'

const tag = (value: object): unknown => Reflect.get(value, Symbol.toStringTag)

test('esmExports: babel is a plain object with a hidden __esModule, node a Module namespace', () => {
  const babel = esmExports('babel')
  assert.equal(Object.getPrototypeOf(babel), Object.prototype)
  assert.equal(Reflect.get(babel, '__esModule'), true)
  assert.deepEqual(Object.keys(babel), [], '__esModule is not enumerable')
  assert.equal(tag(babel), undefined)

  const node = esmExports('node')
  assert.equal(Object.getPrototypeOf(node), null)
  assert.equal(tag(node), 'Module')
  assert.equal(Reflect.get(node, '__esModule'), undefined)
  assert.deepEqual(Reflect.ownKeys(node), [Symbol.toStringTag])
})

test('cjsNamespace under babel: default first, then the own keys, as Babel’s wildcard', () => {
  const value = { b: 2, default: 'own default', a: 1 }
  const namespace = cjsNamespace(value, 'babel')
  assert.deepEqual(Object.keys(namespace), ['default', 'b', 'a'])
  assert.equal(Reflect.get(namespace, 'default'), value, 'default is the whole value')
  assert.equal(Object.getPrototypeOf(namespace), null)
  assert.equal(tag(namespace), undefined)
})

test('cjsNamespace under babel: a value with __esModule is its own namespace', () => {
  const value = { __esModule: true, default: 'inner', named: 'n' }
  assert.equal(cjsNamespace(value, 'babel'), value)
  // The spread of a module loses the non-enumerable marker (mod-partial): then it is wrapped.
  const spread = { ...esmExports('babel'), default: 'd', named: 'n' }
  assert.deepEqual(Object.keys(cjsNamespace(spread, 'babel')), ['default', 'named'])
})

test('cjsNamespace under node: every key sorted with default among them, and the Module tag', () => {
  const value = { zed: 1, default: 'ignored', __esModule: true, alpha: 2 }
  const namespace = cjsNamespace(value, 'node')
  assert.deepEqual(Object.keys(namespace), ['__esModule', 'alpha', 'default', 'zed'])
  assert.equal(
    Reflect.get(namespace, 'default'),
    value,
    'default is module.exports, __esModule or not',
  )
  assert.equal(tag(namespace), 'Module')
})

test('cjsNamespace copies descriptors as they stand: data is a snapshot, a getter stays one', () => {
  let live = 1
  const value = {
    data: 1,
    get getter() {
      return live
    },
  }
  for (const interop of ['babel', 'node'] as const) {
    const namespace = cjsNamespace(value, interop)
    value.data = 2
    live = 3
    assert.equal(Reflect.get(namespace, 'data'), 1, interop)
    assert.equal(Reflect.get(namespace, 'getter'), 3, interop)
    value.data = 1
    live = 1
  }
})

test('cjsNamespace: a primitive is { default }, and a namespace stays as it is', () => {
  for (const interop of ['babel', 'node'] as const) {
    assert.deepEqual(cjsNamespace(5, interop), { default: 5 })
    assert.deepEqual(cjsNamespace(null, interop), { default: null })
    const namespace = esmExports('node')
    assert.equal(cjsNamespace(namespace, interop), namespace)
  }
  assert.equal(isNamespace(esmExports('node')), true)
  assert.equal(isNamespace(esmExports('babel')), false)
})

test('cjsNamespace builds one namespace per value and interop when given a cache', () => {
  const cache = createInteropCache()
  const value = { a: 1 }
  const first = cjsNamespace(value, 'babel', cache)
  assert.equal(cjsNamespace(value, 'babel', cache), first)
  assert.notEqual(cjsNamespace(value, 'node', cache), first)
  assert.notEqual(cjsNamespace(value, 'babel'), first, 'no cache, no reuse')
})

test('cjsNamespace: a function value keeps its own keys too', () => {
  const fn = Object.assign(() => 1, { extra: 'x' })
  const namespace = cjsNamespace(fn, 'babel')
  assert.equal(Reflect.get(namespace, 'default'), fn)
  assert.equal(Reflect.get(namespace, 'extra'), 'x')
})

test('actualView under babel: sorted getters over the live exports, a hidden __esModule', () => {
  const exports = esmExports('babel')
  exports.named = 'n'
  exports.default = 'd'
  exports.other = 'o'
  const view = actualView(exports, 'babel')
  assert.deepEqual(Object.keys(view), ['default', 'named', 'other'])
  assert.equal(Reflect.get(view, '__esModule'), true)
  assert.equal(Object.getOwnPropertyDescriptor(view, '__esModule')?.enumerable, false)
  exports.named = 'changed'
  assert.equal(Reflect.get(view, 'named'), 'changed', 'live')
  assert.equal(typeof Object.getOwnPropertyDescriptor(view, 'named')?.get, 'function')
  // A spread keeps `default` and loses the marker, which mod-partial records for Jest.
  assert.deepEqual(Object.keys({ ...view }), ['default', 'named', 'other'])
})

test('actualView under node: a Module view in source order', () => {
  const exports = esmExports('node')
  exports.zed = 1
  exports.alpha = 2
  const view = actualView(exports, 'node')
  assert.deepEqual(Object.keys(view), ['zed', 'alpha'])
  assert.equal(tag(view), 'Module')
  assert.equal(Reflect.get(view, '__esModule'), undefined)
})
