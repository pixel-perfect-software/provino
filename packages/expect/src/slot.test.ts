import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { ExpectError } from './errors.ts'
import { manualCurrentTest, testTask } from './internal/test-support.ts'
import {
  createMatcherRegistry,
  installMatchersSlot,
  MATCHERS_SLOT,
  type MatchersSlot,
  type SlotHandle,
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
