import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { EqualityTester, Matcher } from '@provino/types'
import { ExpectError } from './errors.ts'
import { manualCurrentTest, testEngine, testTask } from './internal/test-support.ts'
import {
  createMatcherRegistry,
  installMatchersSlot,
  MATCHERS_SLOT,
  type MatchersSlot,
  type SlotHandle,
  snapshotRegistry,
} from './slot.ts'
import { createStateSource } from './state.ts'

let handle: SlotHandle | undefined

afterEach(() => {
  handle?.uninstall()
  handle = undefined
})

const slotValue = (): MatchersSlot => Reflect.get(globalThis, MATCHERS_SLOT) as MatchersSlot

test('the slot is a configurable property sharing the registry`s objects', () => {
  const current = manualCurrentTest()
  const source = createStateSource(current, { nameSeparator: ' ', expand: false })
  const registry = createMatcherRegistry()
  handle = installMatchersSlot(source, registry)
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, MATCHERS_SLOT)
  assert.equal(descriptor?.configurable, true)
  assert.equal(slotValue().matchers, registry.matchers)
  assert.equal(slotValue().customEqualityTesters, registry.customEqualityTesters)
  assert.equal(MATCHERS_SLOT, Symbol.for('$$jest-matchers-object'))
  // Jest's three own keys; `utils` is ours and not enumerable.
  assert.deepEqual(Object.keys(slotValue()), ['matchers', 'customEqualityTesters', 'state'])
  registry.utils = { tag: 'later' }
  assert.deepEqual(slotValue().utils, { tag: 'later' })
})

test('the slot`s state follows the current test', () => {
  const current = manualCurrentTest()
  const source = createStateSource(current, { nameSeparator: ' ', expand: false })
  handle = installMatchersSlot(source, createMatcherRegistry())
  assert.equal(slotValue().state, source.file())
  current.enter(testTask('a'))
  slotValue().state.assertionCalls++
  assert.equal(source.current().assertionCalls, 1)
  current.enter(testTask('b'))
  assert.equal(slotValue().state.assertionCalls, 0)
})

test('a second install throws EXPECT_SLOT_TAKEN; uninstall frees the slot', () => {
  const source = createStateSource(manualCurrentTest(), { nameSeparator: ' ', expand: false })
  handle = installMatchersSlot(source, createMatcherRegistry())
  assert.throws(
    () => installMatchersSlot(source, createMatcherRegistry()),
    (error: unknown) => error instanceof ExpectError && error.code === 'EXPECT_SLOT_TAKEN',
  )
  handle.uninstall()
  assert.equal(Object.hasOwn(globalThis, MATCHERS_SLOT), false)
  handle = installMatchersSlot(source, createMatcherRegistry())
})

test('uninstall leaves a slot it doesn`t own alone', () => {
  const source = createStateSource(manualCurrentTest(), { nameSeparator: ' ', expand: false })
  const first = installMatchersSlot(source, createMatcherRegistry())
  first.uninstall()
  handle = installMatchersSlot(source, createMatcherRegistry())
  first.uninstall()
  assert.equal(Object.hasOwn(globalThis, MATCHERS_SLOT), true)
})

const pass: Matcher = () => ({ pass: true, message: () => '' })
const tester: EqualityTester = () => undefined

test('restore deletes the matchers added since the snapshot and keeps the older ones', () => {
  const registry = createMatcherRegistry()
  registry.matchers.old = pass
  const snapshot = snapshotRegistry(registry)
  registry.matchers.added = pass
  Object.defineProperty(registry.matchers, 'hidden', { value: pass, configurable: true })
  const symbol = Symbol('s')
  Reflect.set(registry.matchers, symbol, pass)
  snapshot.restore()
  assert.deepEqual(Reflect.ownKeys(registry.matchers), ['old'])
  assert.equal(registry.matchers.old, pass)
})

test('restore puts back a matcher that was replaced', () => {
  const registry = createMatcherRegistry()
  const original: Matcher = () => ({ pass: true, message: () => 'original' })
  registry.matchers.toBeThing = original
  const snapshot = snapshotRegistry(registry)
  registry.matchers.toBeThing = pass
  snapshot.restore()
  assert.equal(registry.matchers.toBeThing, original)
})

test('restore resets the equality testers to the snapshot’s, in the same array', () => {
  const registry = createMatcherRegistry()
  const kept = tester
  registry.customEqualityTesters.push(kept)
  const testers = registry.customEqualityTesters
  const snapshot = snapshotRegistry(registry)
  registry.customEqualityTesters.push(
    () => true,
    () => false,
  )
  snapshot.restore()
  assert.equal(registry.customEqualityTesters, testers)
  assert.deepEqual(registry.customEqualityTesters, [kept])
  // A tester that replaced the old one in place goes back too.
  registry.customEqualityTesters[0] = () => true
  snapshot.restore()
  assert.equal(registry.customEqualityTesters[0], kept)
})

test('a snapshot can be restored after each file', () => {
  const registry = createMatcherRegistry()
  const snapshot = snapshotRegistry(registry)
  for (const file of ['a', 'b', 'c']) {
    assert.deepEqual(Reflect.ownKeys(registry.matchers), [], `before ${file}`)
    assert.equal(registry.customEqualityTesters.length, 0, `before ${file}`)
    registry.matchers[`from_${file}`] = pass
    registry.customEqualityTesters.push(tester)
    snapshot.restore()
  }
  assert.deepEqual(Reflect.ownKeys(registry.matchers), [])
})

test('restoring with nothing changed leaves the registry as it was', () => {
  const registry = createMatcherRegistry()
  registry.matchers.old = pass
  const descriptor = Reflect.getOwnPropertyDescriptor(registry.matchers, 'old')
  snapshotRegistry(registry).restore()
  assert.deepEqual(Reflect.getOwnPropertyDescriptor(registry.matchers, 'old'), descriptor)
})

test('after a restore, an engine no longer has the extended matcher or equality tester', () => {
  const { expect, registry } = testEngine()
  const snapshot = snapshotRegistry(registry)
  expect.extend({
    toBeEven: (received: number) => ({ pass: received % 2 === 0, message: () => 'x' }),
  })
  expect.addEqualityTesters([(a, b) => (a === 'x' && b === 'y' ? true : undefined)])
  const loose = expect as unknown as (value: unknown) => Record<string, (() => void) | undefined>
  assert.equal(typeof loose(2).toBeEven, 'function')
  expect('x').toEqual('y')

  snapshot.restore()
  assert.equal(loose(2).toBeEven, undefined)
  assert.throws(() => expect('x').toEqual('y'))
  expect(1).toBe(1) // the table’s own matchers are still there
})
