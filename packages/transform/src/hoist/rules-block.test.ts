// The enclosing-block rules (the shape Jest's plugin has), one rule per case. Track 3 F4.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertOrder, assertUntouched, errorCodes, hoist } from './test-helpers.ts'
import { blockPolicy as policy } from './test-policies.ts'

test('block: mock with a literal argument moves above earlier code', () => {
  const result = hoist("foo()\njest.mock('./a')\nbar()\n", policy)
  assertOrder(result.code, "jest.mock('./a')", 'foo()', 'bar()')
  assert.deepEqual(result.diagnostics, [])
  assert.equal(result.rewroteImports, false)
})

test('block: mock with an inline factory moves', () => {
  const result = hoist("foo()\njest.mock('./a', () => ({ a: 1 }))\n", policy)
  assertOrder(result.code, "jest.mock('./a'", 'foo()')
})

test('block: mock takes a factory and options (three arguments)', () => {
  const result = hoist("foo()\njest.mock('./a', () => 1, { virtual: true })\n", policy)
  assertOrder(result.code, "jest.mock('./a'", 'foo()')
})

test('block: unmock and deepUnmock take one string and move', () => {
  const result = hoist("foo()\njest.unmock('./a')\njest.deepUnmock('./b')\n", policy)
  assertOrder(result.code, "jest.unmock('./a')", "jest.deepUnmock('./b')", 'foo()')
})

test('block: enableAutomock and disableAutomock take no arguments and move', () => {
  const result = hoist('foo()\njest.enableAutomock()\njest.disableAutomock()\n', policy)
  assertOrder(result.code, 'jest.enableAutomock()', 'jest.disableAutomock()', 'foo()')
})

test('block: unmock with the wrong arguments stays where it is, with no error', () => {
  const code = "foo()\njest.unmock('./a', 1)\njest.enableAutomock(true)\n"
  assertUntouched(code, hoist(code, policy))
})

test('block: doMock and dontMock are never hoisted', () => {
  const code = "foo()\njest.doMock('./a')\njest.dontMock('./b')\n"
  assertUntouched(code, hoist(code, policy))
})

test('block: mock with a non-literal path is not hoisted and is not an error', () => {
  const code = 'foo()\njest.mock(path)\n'
  assertUntouched(code, hoist(code, policy))
})

test('block: a factory that is not an inline function is an error with the policy text', () => {
  const result = hoist("jest.mock('./a', notAFunction)\n", policy)
  assert.deepEqual(errorCodes(result), ['HOIST_FACTORY_NOT_FUNCTION'])
  assert.equal(
    result.diagnostics[0]?.message,
    'the factory of jest.mock must be an inline function',
  )
  assert.equal(result.diagnostics[0]?.severity, 'error')
  assert.deepEqual(result.diagnostics[0]?.loc, { line: 1, column: 18 })
  assert.match(result.diagnostics[0]?.codeFrame ?? '', /notAFunction/)
  assert.equal(result.code, "jest.mock('./a', notAFunction)\n", 'on error the input comes back')
})

test('block: a shadowed jest is not the mock object', () => {
  const code = "function f(jest) { jest.mock('./a') }\nconst g = (jest) => { jest.mock('./b') }\n"
  assertUntouched(code, hoist(code, policy))
})

test('block: a named import of the runner module is a mock object under any alias', () => {
  const result = hoist("import { jest as j } from '@jest/globals'\nfoo()\nj.mock('./a')\n", policy)
  assertOrder(result.code, "j.mock('./a')", 'foo()')
})

test('block: a namespace import member is a mock object', () => {
  const result = hoist("import * as G from '@jest/globals'\nfoo()\nG.jest.mock('./a')\n", policy)
  assertOrder(result.code, "G.jest.mock('./a')", 'foo()')
})

test('block: chained calls move as one statement', () => {
  const result = hoist("foo()\njest.mock('./a').mock('./b')\n", policy)
  assertOrder(result.code, "jest.mock('./a').mock('./b')", 'foo()')
  assert.deepEqual(
    result.staticMocks.map((call) => call.specifier),
    ['./a', './b'],
  )
})

test('block: a chain with one call that does not hoist stays put', () => {
  const code = "foo()\njest.mock('./a').doMock('./b')\n"
  assertUntouched(code, hoist(code, policy))
})

test('block: a call inside a block moves to the top of that block, not the file', () => {
  const result = hoist("describe('x', () => {\n  foo()\n  jest.mock('./a')\n})\nbar()\n", policy)
  assertOrder(result.code, "describe('x'", "jest.mock('./a')", 'foo()', 'bar()')
  assert.equal(result.rewroteImports, false)
})

test('block: a block-level call leaves static imports alone', () => {
  const result = hoist(
    "import { a } from './a'\ndescribe('x', () => {\n  foo(a)\n  jest.mock('./b')\n})\n",
    policy,
  )
  assert.equal(result.rewroteImports, false)
  assert.ok(result.code.includes("import { a } from './a'"))
  assert.ok(!result.code.includes('__provino_import_'))
})

test('block: only expression statements move', () => {
  const code = "foo()\nconst r = jest.mock('./a')\nbar(jest.mock('./b'))\n"
  assertUntouched(code, hoist(code, policy))
})

test('block: a factory reading an out-of-scope variable is an error naming it', () => {
  const result = hoist("const outside = f()\njest.mock('./a', () => outside + 1)\n", policy)
  assert.deepEqual(errorCodes(result), ['HOIST_FACTORY_OUT_OF_SCOPE'])
  assert.equal(result.diagnostics[0]?.message, 'out of scope: outside in jest.mock')
  assert.deepEqual(result.diagnostics[0]?.loc, { line: 2, column: 24 })
})

test('block: a factory may read globals on the allow list and mock-prefixed names', () => {
  const result = hoist(
    "const mockValue = f()\nconst MOCK_UPPER = f()\nconst cov_1 = f()\njest.mock('./a', () => ({ a: Math.max(1), b: mockValue, c: MOCK_UPPER, d: cov_1, e: require('x') }))\n",
    policy,
  )
  assert.deepEqual(result.diagnostics, [])
  assertOrder(result.code, "jest.mock('./a'", 'const mockValue')
})

test('block: the coverage pattern is case sensitive, as upstream', () => {
  const result = hoist("const Cov_1 = f()\njest.mock('./a', () => Cov_1)\n", policy)
  assert.deepEqual(errorCodes(result), ['HOIST_FACTORY_OUT_OF_SCOPE'])
})

test('block: names bound inside the factory are not references', () => {
  const result = hoist(
    "jest.mock('./a', () => { const local = 1; return (arg) => local + arg })\n",
    policy,
  )
  assert.deepEqual(result.diagnostics, [])
})

test('block: a const with a pure initializer is hoisted along with the call', () => {
  const result = hoist("foo()\nconst answer = 6 * 7\njest.mock('./a', () => answer)\n", policy)
  assert.deepEqual(result.diagnostics, [])
  assertOrder(result.code, 'const answer = 6 * 7', "jest.mock('./a'", 'foo()')
})

test('block: a const with an impure initializer is an error', () => {
  const result = hoist("const answer = compute()\njest.mock('./a', () => answer)\n", policy)
  assert.deepEqual(errorCodes(result), ['HOIST_FACTORY_OUT_OF_SCOPE'])
})

test('block: a mock-prefixed const is allowed by name and is not moved', () => {
  const result = hoist("foo()\nconst mockV = 2\njest.mock('./a', () => mockV)\n", policy)
  assert.deepEqual(result.diagnostics, [])
  assertOrder(result.code, "jest.mock('./a'", 'foo()', 'const mockV = 2')
})

test('block: the runner module import stays first, then the hoisted calls', () => {
  const result = hoist(
    "import { jest } from '@jest/globals'\nimport { a } from './a'\nfoo(a)\njest.mock('./a')\n",
    policy,
  )
  assertOrder(
    result.code,
    "import { jest } from '@jest/globals'",
    "jest.mock('./a')",
    'const __provino_import_0__',
    'foo(__provino_import_0__.a)',
  )
  assert.ok(!result.code.includes('await import("@jest/globals")'))
})

test('block: the imported jest may be read by a factory', () => {
  const result = hoist(
    "import { jest } from '@jest/globals'\njest.mock('./a', () => ({ f: jest.fn() }))\n",
    policy,
  )
  assert.deepEqual(result.diagnostics, [])
})

test('block: static mocks list hoisted calls with literal specifiers in source order', () => {
  const result = hoist(
    "jest.mock('./b', () => ({}))\njest.mock('./a')\njest.unmock(name)\njest.enableAutomock()\n",
    policy,
  )
  assert.deepEqual(result.staticMocks, [
    {
      method: 'mock',
      specifier: './b',
      hasFactory: true,
      automock: false,
      factoryLoadsOriginal: false,
      loc: { line: 1, column: 1 },
    },
    {
      method: 'mock',
      specifier: './a',
      hasFactory: false,
      automock: true,
      factoryLoadsOriginal: false,
      loc: { line: 2, column: 1 },
    },
  ])
})

test('block: a factory that loads the actual module is flagged', () => {
  const result = hoist(
    "jest.mock('./a', () => ({ ...jest.requireActual('./a') }))\njest.mock('./b', (original) => original)\n",
    policy,
  )
  assert.deepEqual(
    result.staticMocks.map((call) => call.factoryLoadsOriginal),
    [true, true],
  )
})

test('block: a hoisted statement without a semicolon is terminated when it moves', () => {
  const result = hoist("foo()\n;(function () {})()\njest.mock('./a')", policy)
  assertOrder(result.code, "jest.mock('./a');", 'foo()')
})
