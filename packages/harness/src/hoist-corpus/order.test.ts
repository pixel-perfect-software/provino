import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatOrder, type OrderOptions, orderOf, sameOrder } from './order.ts'

const NAMES = new Set([
  'mock',
  'unmock',
  'deepUnmock',
  'enableAutomock',
  'disableAutomock',
  'hoisted',
])
const RUNNERS = new Set(['vitest', '@jest/globals', 'vite-plus/test'])
const reference: OrderOptions = {
  hoistedNames: NAMES,
  runnerModules: RUNNERS,
  staticImports: 'after-hoisted',
}
const ours: OrderOptions = { ...reference, staticImports: 'first' }

/** One expected block. */
const block = (depth: number, ...events: string[]) => ({ depth, events })

test("Babel's output, ours and Vitest's read as the same sequence", () => {
  const babel = [
    "import { jest } from '@jest/globals'",
    'function _getJestObj() {',
    '  const { jest } = require("@jest/globals")',
    '  return jest',
    '}',
    "_getJestObj().mock('./a', () => ({}))",
    "import a from './a'",
    "import b from './b'",
  ].join('\n')
  const provino = [
    "jest.mock('./a', () => ({}))",
    "const __provino_import_0__ = await import('./a')",
    "const __provino_import_1__ = await import('./b')",
  ].join('\n')
  const vitest = [
    "vi.mock('./a', () => ({}))",
    'const __vi_import_0__ = await import("./a");',
    'const __vi_import_1__ = await import("./b");',
    "import { vi } from 'vitest'",
  ].join('\n')
  const expected = [block(0, 'mock:./a', 'load:./a', 'load:./b')]
  assert.deepEqual(orderOf(babel, reference), expected)
  assert.deepEqual(orderOf(provino, ours), expected)
  assert.deepEqual(orderOf(vitest, reference), expected)
  assert.ok(sameOrder(orderOf(babel, reference), orderOf(provino, ours)))
})

test('a mock below a static import that the engine left in place is a wrong order', () => {
  const left = "import a from './a'\njest.mock('./a')"
  assert.deepEqual(orderOf(left, ours), [block(0, 'load:./a', 'mock:./a')])
  const right = "jest.mock('./a')\nconst x = await import('./a')"
  assert.equal(sameOrder(orderOf(left, ours), orderOf(right, ours)), false)
  // The reference models a CommonJS conversion after hoisting, so the same text reads as hoisted.
  assert.deepEqual(orderOf(left, reference), [block(0, 'mock:./a', 'load:./a')])
})

test('a module load before the hoisted call is a wrong order', () => {
  const wrong = "const __provino_import_0__ = await import('./a')\njest.mock('./a')"
  const right = "jest.mock('./a')\nconst __provino_import_0__ = await import('./a')"
  assert.equal(sameOrder(orderOf(wrong, ours), orderOf(right, ours)), false)
})

test('other mismatches are wrong too: specifier, method, call order, a missing event', () => {
  const base = orderOf("jest.mock('./a')\njest.unmock('./b')", ours)
  assert.equal(sameOrder(base, orderOf("jest.mock('./a')\njest.unmock('./c')", ours)), false)
  assert.equal(sameOrder(base, orderOf("jest.mock('./a')\njest.deepUnmock('./b')", ours)), false)
  assert.equal(sameOrder(base, orderOf("jest.unmock('./b')\njest.mock('./a')", ours)), false)
  assert.equal(sameOrder(base, orderOf("jest.mock('./a')", ours)), false)
  assert.equal(sameOrder(base, orderOf("jest.mock('./a')\njest.unmock('./b')", ours)), true)
})

test('a chain reads in call order', () => {
  assert.deepEqual(orderOf("jest.mock('a').mock('b').unmock('c')", ours), [
    block(0, 'mock:a', 'mock:b', 'unmock:c'),
  ])
})

test('blocks are compared one by one, with their depth', () => {
  const babel = ['beforeEach(() => {', "  jest.mock('someNode')", "  require('x')", '})'].join('\n')
  assert.deepEqual(orderOf(babel, reference), [block(1, 'mock:someNode', 'load:x')])
  const swapped = ['beforeEach(() => {', "  require('x')", "  jest.mock('someNode')", '})'].join(
    '\n',
  )
  assert.equal(sameOrder(orderOf(babel, reference), orderOf(swapped, reference)), false)
  // The same events moved out of the block into the program are a different shape.
  const moved = "jest.mock('someNode')\nrequire('x')\nbeforeEach(() => {})"
  assert.equal(sameOrder(orderOf(babel, reference), orderOf(moved, reference)), false)
  const nested = [
    'a()',
    "describe('d', () => {",
    "  vi.mock('in')",
    '  if (x) {',
    "    vi.mock('deep')",
    '  }',
    '})',
  ].join('\n')
  assert.deepEqual(orderOf(nested, ours), [block(1, 'mock:in'), block(2, 'mock:deep')])
})

test('values, import() arguments and non-hoisted calls', () => {
  const code = [
    "const v = vi.hoisted(() => { vi.mock('inside-a-function-is-its-own-block') })",
    "vi.mock(import('./p'))",
    "vi.doMock('./not-hoisted')",
    'export const w = await vi.hoisted(async () => ({}))',
  ].join('\n')
  assert.deepEqual(orderOf(code, ours), [
    block(0, 'hoisted', 'mock:./p', 'hoisted'),
    block(1, 'mock:inside-a-function-is-its-own-block'),
  ])
})

test('runner modules are not module loads, and an empty file has no events', () => {
  assert.deepEqual(
    orderOf("import { vi } from 'vitest'\nimport { jest } from '@jest/globals'", ours),
    [],
  )
  assert.deepEqual(
    orderOf("import 'vite-plus/test'\nconst { jest } = require('@jest/globals')", ours),
    [],
  )
  assert.deepEqual(orderOf('', ours), [])
})

test('requires, dynamic imports and `export … from` are loads', () => {
  const code = "const a = require('./a')\nexport * from './b'\nconst c = await import('./c')"
  assert.deepEqual(orderOf(code, ours), [block(0, 'load:./b', 'load:./a', 'load:./c')])
})

test('code that does not parse throws, so a broken printer fails the check', () => {
  assert.throws(() => orderOf('jest.mock(', ours), /does not parse/)
})

test('formatOrder names the block and the events', () => {
  assert.equal(formatOrder([]), '(no events)')
  assert.equal(
    formatOrder([block(0, 'mock:a', 'load:a'), block(1, 'mock:b')]),
    'block 0 (depth 0): mock:a > load:a\nblock 1 (depth 1): mock:b',
  )
})
