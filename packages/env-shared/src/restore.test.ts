// The snapshot on plain objects: the cases a real global cannot be used for, because a
// non-configurable property can never be removed from it again.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { leakReport, snapshotProperties } from './restore.ts'

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
  assert.deepEqual(snapshot.restore(), ['stuck', stuckSymbol])
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
  assert.deepEqual(snapshot.restore(), ['x'])
})

test('a non-configurable property that only changed value is restored', () => {
  const target: Record<string, unknown> = {}
  Object.defineProperty(target, 'x', { value: 1, writable: true, configurable: false })
  const snapshot = snapshotProperties(target)
  target.x = 2
  assert.deepEqual(snapshot.restore(), [])
  assert.equal(target.x, 1)
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

/**
 * A get/set accessor whose value lives in a closure, the shape of Node's `process`, `Buffer` and
 * `performance`, with a count of the calls to each side and the receivers the setter saw.
 */
function closureAccessor(
  target: object,
  key: string,
): {
  readonly state: { value: string; reads: number; writes: number }
  readonly receivers: unknown[]
} {
  const state = { value: 'original', reads: 0, writes: 0 }
  const receivers: unknown[] = []
  Object.defineProperty(target, key, {
    get(): string {
      state.reads++
      return state.value
    },
    set(this: unknown, value: string) {
      state.writes++
      receivers.push(this)
      state.value = value
    },
    enumerable: true,
    configurable: true,
  })
  return { state, receivers }
}

test('a plain assignment over a get/set accessor is undone, and the getter is read once', () => {
  const target: Record<string, unknown> = {}
  const { state, receivers } = closureAccessor(target, 'cell')
  const before = Object.getOwnPropertyDescriptors(target)
  const snapshot = snapshotProperties(target)
  target.cell = 'first'
  target.cell = 'second'
  assert.equal(state.value, 'second')
  assert.deepEqual(snapshot.restore(), [])
  assert.equal(state.value, 'original')
  assert.deepStrictEqual(Object.getOwnPropertyDescriptors(target), before)
  assert.equal(state.reads, 1, 'read once, by the wrapper on the first assignment')
  assert.deepEqual(receivers, [target, target, target], 'the setter still gets the receiver')
})

test('nothing assigned: no getter or setter is called, and the descriptor is untouched', () => {
  const target: Record<string, unknown> = {}
  const { state } = closureAccessor(target, 'cell')
  const before = Object.getOwnPropertyDescriptors(target)
  const snapshot = snapshotProperties(target)
  assert.deepEqual(snapshot.restore(), [])
  assert.deepStrictEqual(Object.getOwnPropertyDescriptors(target), before)
  assert.deepEqual(state, { value: 'original', reads: 0, writes: 0 })
})

test('while set up, only a configurable accessor with both sides is wrapped', () => {
  const target: Record<string, unknown> = {}
  Object.defineProperty(target, 'getterOnly', { get: () => 1, configurable: true })
  Object.defineProperty(target, 'setterOnly', { set: () => {}, configurable: true })
  Object.defineProperty(target, 'fixed', { get: () => 1, set: () => {}, configurable: false })
  Object.defineProperty(target, 'data', { value: 1, writable: true, configurable: true })
  const before = Object.getOwnPropertyDescriptors(target)
  const snapshot = snapshotProperties(target)
  assert.deepStrictEqual(Object.getOwnPropertyDescriptors(target), before)
  closureAccessor(target, 'cell')
  assert.deepEqual(snapshot.restore(), [])
})

test('a getter that throws on the first assignment is reported, and the assignment still goes through', () => {
  const target: Record<string, unknown> = {}
  let value = 'original'
  Object.defineProperty(target, 'cell', {
    get(): string {
      throw new Error('not readable')
    },
    set(next: string) {
      value = next
    },
    configurable: true,
  })
  const before = Object.getOwnPropertyDescriptors(target)
  const snapshot = snapshotProperties(target)
  target.cell = 'assigned'
  assert.equal(value, 'assigned', 'the setter ran as it would have without the environment')
  assert.deepEqual(snapshot.restore(), ['cell'], 'the old value is unknown, so the key is left')
  assert.deepStrictEqual(Object.getOwnPropertyDescriptors(target), before)
})

test('a setter that throws when the old value is put back is reported, and the rest is restored', () => {
  const target: Record<string, unknown> = { plain: 1 }
  let allow = true
  Object.defineProperty(target, 'cell', {
    get: () => 'old',
    set() {
      if (!allow) throw new Error('refused')
    },
    configurable: true,
  })
  const snapshot = snapshotProperties(target)
  target.cell = 'assigned'
  target.plain = 2
  allow = false
  assert.deepEqual(snapshot.restore(), ['cell'])
  assert.equal(target.plain, 1)
})

test('a second restore does not replay an assignment made after the first', () => {
  const target: Record<string, unknown> = {}
  const { state } = closureAccessor(target, 'cell')
  const snapshot = snapshotProperties(target)
  target.cell = 'during the file'
  assert.deepEqual(snapshot.restore(), [])
  target.cell = 'after the file'
  assert.deepEqual(snapshot.restore(), [])
  assert.equal(state.value, 'after the file', 'the wrapper is gone, so there is nothing to replay')
})

test('leakReport is nothing for a clean restore, else the keys as strings', () => {
  assert.equal(leakReport([]), undefined)
  assert.deepEqual(leakReport(['a', Symbol('b')]), { leakedGlobals: ['a', 'Symbol(b)'] })
})
