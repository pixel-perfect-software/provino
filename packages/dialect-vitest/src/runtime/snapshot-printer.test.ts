// The Vitest dialect's snapshot printer: the ref in the policy loads it, it serializes with the
// vendored @vitest/pretty-format 5.0.5 and Vitest's plugin order, and its messages are Vitest's.
// The bytes of a whole `.snap` are held to Vitest's by `@provino/harness`'s snapshot corpus.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBehaviourLoader, isModuleRef } from '@provino/policy'
import type { SnapshotMessageInfo, SnapshotSerializeOptions } from '@provino/types'
import { vitestPolicy } from '../dialect.ts'
import { vitestSnapshotPrinter } from './snapshot-printer.ts'

const format = { escapeString: false, printBasicPrototype: false }
const options = (over: Partial<SnapshotSerializeOptions> = {}): SnapshotSerializeOptions => ({
  format,
  plugins: [],
  ...over,
})
const printer = vitestSnapshotPrinter()

test('the policy`s printer ref loads vitestSnapshotPrinter through the behaviour loader', async () => {
  const ref = vitestPolicy.snapshot?.printer
  assert.ok(ref !== undefined && ref !== null && isModuleRef(ref))
  assert.equal(await createBehaviourLoader().load(ref), vitestSnapshotPrinter)
})

test('serializes with indent 2, bare strings, no basic prototype and no function names', () => {
  assert.equal(
    printer.serialize({ a: [1, 'two"'], f() {} }, options()),
    '{\n  "a": [\n    1,\n    "two"",\n  ],\n  "f": [Function],\n}',
  )
})

test('prints an error as its name and message, with no stack and no cause', () => {
  assert.equal(
    printer.serialize(new TypeError('typed', { cause: new Error('inner') }), options()),
    '[TypeError: typed]',
  )
})

test('stops going deeper once a level has printed more than the output cap the policy gives', () => {
  const value = { list: ['x'.repeat(60), { deep: 1 }] }
  assert.match(printer.serialize(value, options()), /"deep": 1/)
  const capped = printer.serialize(value, options({ format: { ...format, maxOutputLength: 50 } }))
  assert.doesNotMatch(capped, /"deep"/)
  assert.match(capped, /\[Object\]/)
})

test('a serializer from the project goes in front, and the mock serializer is last', () => {
  const mock = {
    _isMockFunction: true,
    getMockName: () => 'vi.fn()',
    mock: { calls: [], results: [] },
  }
  assert.equal(printer.serialize(mock, options()), '[MockFunction]')
  const first = { test: (value: unknown) => value === mock, serialize: () => 'mine' }
  assert.equal(printer.serialize(mock, options({ plugins: [first] })), 'mine')
})

test('a serializer in the old shape (print) works too', () => {
  const old = { test: (value: unknown) => value === 'x', print: () => 'printed' }
  assert.equal(printer.serialize({ k: 'x' }, options({ plugins: [old] })), '{\n  "k": printed,\n}')
})

const info: SnapshotMessageInfo = {
  matcherName: 'toMatchSnapshot',
  isInline: false,
  hint: 'the hint',
  currentTestName: 'outer > inner',
  key: 'outer > inner > the hint 2',
  count: 2,
  expand: false,
  expected: '"old"',
  actual: '"new"',
  received: 'new',
}

test('a mismatch, and a snapshot that was not written, only name the key; its reporter diffs', () => {
  assert.equal(printer.messages.mismatch(info), 'Snapshot `outer > inner > the hint 2` mismatched')
  assert.equal(
    printer.messages.notWritten({ ...info, expected: undefined }),
    'Snapshot `outer > inner > the hint 2` mismatched',
  )
})

test('properties that don`t match say so in one line', () => {
  assert.equal(printer.messages.propertiesMismatch(info), 'Snapshot properties mismatched')
})
