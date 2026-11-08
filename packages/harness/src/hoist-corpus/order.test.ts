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
const block = (depth: number, owner: string, ...events: string[]) => ({ depth, owner, events })

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
  const expected = [block(0, 'program', 'mock:./a', 'load:./a', 'load:./b')]
  assert.deepEqual(orderOf(babel, reference), expected)
  assert.deepEqual(orderOf(provino, ours), expected)
  assert.deepEqual(orderOf(vitest, reference), expected)
  assert.ok(sameOrder(orderOf(babel, reference), orderOf(provino, ours)))
})

test('a mock below a static import that the engine left in place is a wrong order', () => {
  const left = "import a from './a'\njest.mock('./a')"
  assert.deepEqual(orderOf(left, ours), [block(0, 'program', 'load:./a', 'mock:./a')])
  const right = "jest.mock('./a')\nconst x = await import('./a')"
  assert.equal(sameOrder(orderOf(left, ours), orderOf(right, ours)), false)
})

test('the CommonJS model keeps only the calls the plugin hoisted above the requires', () => {
  const hoisted = "_getJestObj().mock('./a')\nimport a from './a'"
  assert.deepEqual(orderOf(hoisted, reference), [block(0, 'program', 'mock:./a', 'load:./a')])
  // A call the plugin left alone (`other.mock`, or `jest.mock(x)` on a bad argument) is below them.
  const stayed = "other.mock('./a')\nimport a from './a'"
  assert.deepEqual(orderOf(stayed, reference), [block(0, 'program', 'load:./a', 'mock:./a')])
  const chained = "_getJestObj().mock('./a').unmock('./b')\nimport a from './a'"
  assert.deepEqual(orderOf(chained, reference), [
    block(0, 'program', 'mock:./a', 'unmock:./b', 'load:./a'),
  ])
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
    block(0, 'program', 'mock:a', 'mock:b', 'unmock:c'),
  ])
})

test('specifiers: a template is read, and anything dynamic still makes an event', () => {
  assert.deepEqual(orderOf('vi.mock(`./a`)', ours), [block(0, 'program', 'mock:./a')])
  assert.deepEqual(orderOf(`vi.mock(\`./\${a}\`)`, ours), [block(0, 'program', 'mock:<dynamic>')])
  assert.deepEqual(orderOf('vi.mock(p)', ours), [block(0, 'program', 'mock:<dynamic>')])
  assert.deepEqual(orderOf('jest.mock(1)', ours), [block(0, 'program', 'mock:<dynamic>')])
  assert.deepEqual(orderOf('jest.enableAutomock()', ours), [block(0, 'program', 'enableAutomock')])
  assert.deepEqual(orderOf('require(x)\nrequire(`./a`)\nimport(x)\nimport(`./b`)', ours), [
    block(0, 'program', 'load:<dynamic>', 'load:./a', 'load:<dynamic>', 'load:./b'),
  ])
})

test('a hoisted const a call reads is an event, and one nothing reads is not', () => {
  const moved = "const a = 1\nconst b = 2\njest.mock('./x', () => a)"
  assert.deepEqual(orderOf(moved, ours), [block(0, 'program', 'const:a', 'mock:./x')])
  const below = "jest.mock('./x', () => a)\nconst a = 1"
  assert.deepEqual(orderOf(below, ours), [block(0, 'program', 'mock:./x', 'const:a')])
  assert.equal(sameOrder(orderOf(moved, ours), orderOf(below, ours)), false)
  const dropped = "jest.mock('./x', () => a)"
  assert.equal(sameOrder(orderOf(moved, ours), orderOf(dropped, ours)), false)
})

test('a const event sees destructuring and exports, and skips names a tool made up', () => {
  assert.deepEqual(orderOf("const { a, b: [c] } = o\njest.mock('./x', () => a + c)", ours), [
    block(0, 'program', 'const:a', 'const:c', 'mock:./x'),
  ])
  assert.deepEqual(orderOf("export const a = 1\njest.mock('./x', () => a)", ours), [
    block(0, 'program', 'const:a', 'mock:./x'),
  ])
  assert.deepEqual(
    orderOf(
      "vi.mock('./x', () => __provino_import_0__.y)\nconst __provino_import_0__ = await import('./y')",
      ours,
    ),
    [block(0, 'program', 'mock:./x', 'load:./y')],
  )
})

test('the CommonJS model keeps a const that stayed below the requires', () => {
  const moved = "const a = 1\n_getJestObj().mock('./x', () => a)\nimport y from './y'"
  assert.deepEqual(orderOf(moved, reference), [
    block(0, 'program', 'const:a', 'mock:./x', 'load:./y'),
  ])
  const stayed = "_getJestObj().mock('./x', (a) => a)\nconst a = 1\nimport y from './y'"
  assert.deepEqual(orderOf(stayed, reference), [
    block(0, 'program', 'mock:./x', 'load:./y', 'const:a'),
  ])
})

test('blocks are compared one by one, with what owns them', () => {
  const babel = ['beforeEach(() => {', "  jest.mock('someNode')", "  require('x')", '})'].join('\n')
  assert.deepEqual(orderOf(babel, reference), [
    block(1, 'program/call:beforeEach', 'mock:someNode', 'load:x'),
  ])
  const swapped = ['beforeEach(() => {', "  require('x')", "  jest.mock('someNode')", '})'].join(
    '\n',
  )
  assert.equal(sameOrder(orderOf(babel, reference), orderOf(swapped, reference)), false)
  // The same events moved out of the block into the program are a different shape.
  const moved = "jest.mock('someNode')\nrequire('x')\nbeforeEach(() => {})"
  assert.equal(sameOrder(orderOf(babel, reference), orderOf(moved, reference)), false)
  // The same events at the same index and depth in another function are not the same block.
  const elsewhere = ['afterEach(() => {', "  jest.mock('someNode')", "  require('x')", '})'].join(
    '\n',
  )
  assert.equal(sameOrder(orderOf(babel, reference), orderOf(elsewhere, reference)), false)
  const nested = [
    'a()',
    "describe('d', () => {",
    "  vi.mock('in')",
    '  if (x) {',
    "    vi.mock('deep')",
    '  }',
    '})',
  ].join('\n')
  assert.deepEqual(orderOf(nested, ours), [
    block(1, 'program/call:describe', 'mock:in'),
    block(2, 'program/call:describe/IfStatement', 'mock:deep'),
  ])
})

test('a block is named for its function, method or statement', () => {
  const owners = (code: string): readonly string[] =>
    orderOf(code, ours).map((entry) => entry.owner)
  assert.deepEqual(owners("function f() { vi.mock('a') }"), ['program/function:f'])
  assert.deepEqual(owners("const g = () => { vi.mock('a') }"), ['program/function:g'])
  assert.deepEqual(owners("const o = { m() { vi.mock('a') } }"), ['program/method:m'])
  assert.deepEqual(owners("class K { static { vi.mock('a') } }"), ['program/StaticBlock'])
  assert.deepEqual(owners("try { vi.mock('a') } catch {}"), ['program/TryStatement'])
  assert.deepEqual(owners("x(function () { vi.mock('a') })"), ['program/call:x'])
  assert.deepEqual(owners("o.y.z(() => { vi.mock('a') })"), ['program/call:z'])
})

test('an expression body is a block of one', () => {
  assert.deepEqual(orderOf("jest.mock('a', () => require('b'))", ours), [
    block(0, 'program', 'mock:a'),
    block(1, 'program/call:mock', 'load:b'),
  ])
})

test('values, import() arguments and non-hoisted calls', () => {
  const code = [
    "const v = vi.hoisted(() => { vi.mock('inside-a-function-is-its-own-block') })",
    "vi.mock(import('./p'))",
    "vi.mock(await import('./q'))",
    "vi.doMock('./not-hoisted')",
    'export const w = await vi.hoisted(async () => ({}))',
  ].join('\n')
  assert.deepEqual(orderOf(code, ours), [
    block(0, 'program', 'hoisted', 'mock:./p', 'mock:./q', 'hoisted'),
    block(1, 'program/call:hoisted', 'mock:inside-a-function-is-its-own-block'),
  ])
})

test('tracked calls are events that never count as hoisted', () => {
  const options: OrderOptions = { ...reference, trackedNames: new Set(['doMock']) }
  assert.deepEqual(orderOf("_getJestObj().doMock('./a')\nimport a from './a'", options), [
    block(0, 'program', 'load:./a', 'doMock:./a'),
  ])
})

test('runner modules and type-only imports are not module loads, and an empty file has no events', () => {
  assert.deepEqual(
    orderOf("import { vi } from 'vitest'\nimport { jest } from '@jest/globals'", ours),
    [],
  )
  assert.deepEqual(
    orderOf("import 'vite-plus/test'\nconst { jest } = require('@jest/globals')", ours),
    [],
  )
  assert.deepEqual(
    orderOf("import type { T } from './t'\nexport type { U } from './u'", {
      ...ours,
      syntax: 'tsx',
    }),
    [],
  )
  assert.deepEqual(orderOf('', ours), [])
})

test('requires, dynamic imports and `export … from` are loads', () => {
  const code = "const a = require('./a')\nexport * from './b'\nconst c = await import('./c')"
  assert.deepEqual(orderOf(code, ours), [block(0, 'program', 'load:./b', 'load:./a', 'load:./c')])
})

test('code that does not parse throws, so a broken printer fails the check', () => {
  assert.throws(() => orderOf('jest.mock(', ours), /does not parse/)
})

test('formatOrder names the block and the events', () => {
  assert.equal(formatOrder([]), '(no events)')
  assert.equal(
    formatOrder([block(0, 'program', 'mock:a', 'load:a'), block(1, 'program/if', 'mock:b')]),
    'block 0 (program): mock:a > load:a\nblock 1 (program/if): mock:b',
  )
})
