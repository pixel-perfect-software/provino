// The Jest dialect's snapshot printer: the ref in the policy loads it, it serializes with
// pretty-format 30.5's defaults and Jest's plugin order, and its messages carry Jest's words. The
// bytes of a whole `.snap` are held to Jest's by `@provino/harness`'s snapshot corpus.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripVTControlCharacters } from 'node:util'
import { createBehaviourLoader, isModuleRef } from '@provino/policy'
import type { SnapshotMessageInfo, SnapshotSerializeOptions } from '@provino/types'
import { jestPolicy } from '../dialect.ts'
import { jestSnapshotPrinter } from './snapshot-printer.ts'

const format = { escapeString: false, printBasicPrototype: false }
const options = (over: Partial<SnapshotSerializeOptions> = {}): SnapshotSerializeOptions => ({
  format,
  plugins: [],
  ...over,
})
const printer = jestSnapshotPrinter()

test('the policy`s printer ref loads jestSnapshotPrinter through the behaviour loader', async () => {
  const ref = jestPolicy.snapshot?.printer
  assert.ok(ref !== undefined && ref !== null && isModuleRef(ref))
  assert.equal(await createBehaviourLoader().load(ref), jestSnapshotPrinter)
})

test('serializes with indent 2, bare strings, no basic prototype and no function names', () => {
  assert.equal(
    printer.serialize({ a: [1, 'two"'], f() {} }, options()),
    '{\n  "a": [\n    1,\n    "two"",\n  ],\n  "f": [Function],\n}',
  )
})

test('turns the options of the policy into pretty-format`s', () => {
  const text = printer.serialize(
    { a: { b: 1 } },
    options({ format: { ...format, printBasicPrototype: true, indent: 4 } }),
  )
  assert.equal(text, 'Object {\n    "a": Object {\n        "b": 1,\n    },\n}')
})

test('a serializer from the project goes in front of Jest`s own plugins', () => {
  const mock = {
    _isMockFunction: true,
    getMockName: () => 'jest.fn()',
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

test('a mock function prints with its calls and results, as jest-snapshot`s serializer does', () => {
  const mock = {
    _isMockFunction: true,
    getMockName: () => 'named',
    mock: { calls: [[1]], results: [{ type: 'return', value: 2 }] },
  }
  assert.equal(
    printer.serialize(mock, options()),
    '[MockFunction named] {\n  "calls": [\n    [\n      1,\n    ],\n  ],\n  "results": [\n    {\n      "type": "return",\n      "value": 2,\n    },\n  ],\n}',
  )
})

const info: SnapshotMessageInfo = {
  matcherName: 'toMatchSnapshot',
  isInline: false,
  hint: 'the hint',
  currentTestName: 'outer inner',
  key: 'outer inner: the hint 2',
  count: 2,
  expand: false,
  expected: '"old"',
  actual: '"new"',
  received: 'new',
}

test('a mismatch names the snapshot as the file does, and shows both sides', () => {
  const text = stripVTControlCharacters(printer.messages.mismatch(info))
  assert.match(text, /expect\(received\)\.toMatchSnapshot\(hint\)/)
  assert.match(text, /Snapshot name: `outer inner: the hint 2`/)
  assert.match(text, /"old"/)
  assert.match(text, /"new"/)
})

test('a snapshot that was not written says why, as Jest does', () => {
  const text = stripVTControlCharacters(
    printer.messages.notWritten({ ...info, hint: '', expected: undefined }),
  )
  assert.match(text, /New snapshot was not written\. The update flag must be explicitly passed/)
  assert.match(text, /continuous integration \(CI\) environment/)
  assert.match(text, /Received: "new"/)
})

test('properties that don`t match show both objects', () => {
  const text = stripVTControlCharacters(
    printer.messages.propertiesMismatch({ ...info, properties: { id: 1 }, received: { id: 2 } }),
  )
  assert.match(text, /toMatchSnapshot\(properties, hint\)/)
  assert.match(text, /Expected properties/)
  assert.match(text, /Received value/)
})
