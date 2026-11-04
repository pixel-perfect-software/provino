// The snapshot on plain objects: the cases a real global cannot be used for, because a
// non-configurable property can never be removed from it again.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NodeEnvironmentError } from '../errors.ts'
import { restoreOrThrow, snapshotProperties } from './restore.ts'

/** An object with a mix of properties, and the descriptors it started with. */
function sample(): { readonly target: Record<string | symbol, unknown>; readonly tag: symbol } {
  const tag = Symbol('tag')
  const target: Record<string | symbol, unknown> = { a: 1, b: 2 }
  Object.defineProperty(target, 'hidden', { value: 'h', configurable: true })
  Object.defineProperty(target, 'getter', { get: () => 1, configurable: true, enumerable: true })
  target[tag] = 't'
  return { target, tag }
}

test('restore puts back changed, deleted and added properties', () => {
  const { target, tag } = sample()
  const before = Object.getOwnPropertyDescriptors(target)
  const snapshot = snapshotProperties(target)
  target.a = 100
  delete target.b
  delete target[tag]
  Object.defineProperty(target, 'hidden', { enumerable: true })
  Object.defineProperty(target, 'getter', { value: 'now a value' })
  target.extra = true
  target[Symbol('extra')] = true
  assert.deepEqual(snapshot.restore(), [])
  assert.deepStrictEqual(Object.getOwnPropertyDescriptors(target), before)
})

test('restore is the identity when nothing changed, and leaves the order alone', () => {
  const { target } = sample()
  const order = Reflect.ownKeys(target)
  const snapshot = snapshotProperties(target)
  assert.deepEqual(snapshot.restore(), [])
  assert.deepEqual(Reflect.ownKeys(target), order)
})

test('a deleted key returns after the keys that were never deleted', () => {
  const { target } = sample()
  const snapshot = snapshotProperties(target)
  delete target.a
  snapshot.restore()
  assert.deepEqual(Reflect.ownKeys(target).slice(0, 4), ['b', 'hidden', 'getter', 'a'])
})

test('deleted keys come back in their original order', () => {
  const { target } = sample()
  const snapshot = snapshotProperties(target)
  delete target.b
  delete target.a
  snapshot.restore()
  const strings = Reflect.ownKeys(target).filter((key) => typeof key === 'string')
  assert.deepEqual(strings, ['hidden', 'getter', 'a', 'b'])
})

test('a non-configurable property added since is reported, and the rest is still restored', () => {
  const { target } = sample()
  const snapshot = snapshotProperties(target)
  Object.defineProperty(target, 'stuck', { value: 1, configurable: false })
  const stuckSymbol = Symbol('stuckSymbol')
  Object.defineProperty(target, stuckSymbol, { value: 1, configurable: false })
  target.a = 100
  target.extra = true
  delete target.b
  assert.deepEqual(snapshot.restore(), [
    { key: 'stuck', action: 'delete' },
    { key: stuckSymbol, action: 'delete' },
  ])
  assert.equal(target.a, 1)
  assert.equal(target.b, 2)
  assert.equal('extra' in target, false)
})

test('a changed property that can no longer be redefined is reported', () => {
  const target: Record<string, unknown> = {}
  Object.defineProperty(target, 'x', { value: 1, writable: true, configurable: false })
  const snapshot = snapshotProperties(target)
  // Writable and non-configurable: the value changes, and `writable` can still go to false.
  Object.defineProperty(target, 'x', { value: 2, writable: false })
  assert.deepEqual(snapshot.restore(), [{ key: 'x', action: 'redefine' }])
})

test('a non-configurable property that only changed value is restored', () => {
  const target: Record<string, unknown> = {}
  Object.defineProperty(target, 'x', { value: 1, writable: true, configurable: false })
  const snapshot = snapshotProperties(target)
  target.x = 2
  assert.deepEqual(snapshot.restore(), [])
  assert.equal(target.x, 1)
})

test('restoreOrThrow throws ENV_NODE_RESTORE_FAILED after restoring everything else', () => {
  const { target } = sample()
  const snapshot = snapshotProperties(target)
  Object.defineProperty(target, 'stuck', { value: 1, configurable: false })
  target.a = 100
  assert.throws(
    () => restoreOrThrow(snapshot),
    (error) => {
      assert.ok(error instanceof NodeEnvironmentError)
      assert.equal(error.code, 'ENV_NODE_RESTORE_FAILED')
      assert.deepEqual(error.failures, [{ key: 'stuck', action: 'delete' }])
      assert.match(error.message, /stuck \(delete\)/)
      return true
    },
  )
  assert.equal(target.a, 1, 'the other change was restored before the throw')
})

test('restoreOrThrow returns quietly when everything was restored', () => {
  const { target } = sample()
  const snapshot = snapshotProperties(target)
  target.extra = 1
  assert.equal(restoreOrThrow(snapshot), undefined)
})

test('capture does not call accessors', () => {
  let calls = 0
  const target = {}
  Object.defineProperty(target, 'lazy', {
    get() {
      calls++
      return 1
    },
    configurable: true,
  })
  snapshotProperties(target).restore()
  assert.equal(calls, 0)
})

test('capture reads descriptors until no new key appears', () => {
  // Reading the descriptor of `lazy` runs code that defines another key, as V8's lazy data
  // properties do: the new key must be part of the baseline, not "added since".
  const target = new Proxy<Record<string | symbol, unknown>>(
    {},
    {
      getOwnPropertyDescriptor(object, key) {
        if (key === 'lazy' && !('loaded' in object)) {
          Object.defineProperty(object, 'loaded', { value: true, configurable: false })
        }
        return Reflect.getOwnPropertyDescriptor(object, key)
      },
    },
  )
  Object.defineProperty(target, 'lazy', { value: 1, configurable: true })
  const snapshot = snapshotProperties(target)
  assert.deepEqual(snapshot.restore(), [], '`loaded` is non-configurable: deleting it would fail')
  assert.equal(Reflect.has(target, 'loaded'), true)
})
