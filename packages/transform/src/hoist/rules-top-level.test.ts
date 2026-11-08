// The top-level-only rules (the shape Vitest's hoister has), one rule per case. Track 3 F4.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertOrder, assertUntouched, errorCodes, hoist } from './test-helpers.ts'
import { topLevelPolicy as policy } from './test-policies.ts'

test('top: mock moves to the top of the file', () => {
  const result = hoist("foo()\nbar()\nvi.mock('./a')\n", policy)
  assertOrder(result.code, "vi.mock('./a')", 'foo()', 'bar()')
  assert.deepEqual(result.diagnostics, [])
})

test('top: mock with a factory and unmock both move, in source order', () => {
  const result = hoist("foo()\nvi.mock('./a', () => ({}))\nvi.unmock('./b')\n", policy)
  assertOrder(result.code, "vi.mock('./a'", "vi.unmock('./b')", 'foo()')
})

test('top: the vitest object hoists like vi', () => {
  const result = hoist("foo()\nvitest.mock('./a')\n", policy)
  assertOrder(result.code, "vitest.mock('./a')", 'foo()')
})

test('top: hoisted alone moves', () => {
  const result = hoist('foo()\nvi.hoisted(() => { globalThis.x = 1 })\n', policy)
  assertOrder(result.code, 'vi.hoisted(', 'foo()')
})

test('top: hoisted assigned moves the whole declaration', () => {
  const result = hoist('foo()\nconst state = vi.hoisted(() => ({ n: 1 }))\n', policy)
  assertOrder(result.code, 'const state = vi.hoisted(', 'foo()')
})

test('top: hoisted awaited moves the await with it', () => {
  const result = hoist('foo()\nawait vi.hoisted(async () => 1)\n', policy)
  assertOrder(result.code, 'await vi.hoisted(', 'foo()')
})

test('top: hoisted destructured moves the whole declaration', () => {
  const result = hoist('foo()\nconst { a, b } = vi.hoisted(() => ({ a: 1, b: 2 }))\n', policy)
  assertOrder(result.code, 'const { a, b } = vi.hoisted(', 'foo()')
})

test('top: doMock is not hoisted but its import() argument is rewritten', () => {
  const code = "foo()\nvi.doMock(import('./a'))\n"
  const result = hoist(code, policy)
  assert.equal(result.code, "foo()\nvi.doMock('./a')\n")
  assert.notEqual(result.map, null)
  assert.deepEqual(result.staticMocks, [])
})

test('top: doUnmock with an awaited import() argument is rewritten', () => {
  const result = hoist("vi.doUnmock(await import('./a'))\n", policy)
  assert.equal(result.code, "vi.doUnmock('./a')\n")
})

test('top: a hoisted mock with an import() argument is rewritten and listed', () => {
  const result = hoist("foo()\nvi.mock(import('./a'))\n", policy)
  assertOrder(result.code, "vi.mock('./a')", 'foo()')
  assert.deepEqual(
    result.staticMocks.map((call) => [call.method, call.specifier]),
    [['mock', './a']],
  )
})

test('top: a mock with an awaited import() argument is rewritten', () => {
  const result = hoist("foo()\nvi.mock(await import('./a'))\n", policy)
  assert.ok(result.code.includes("vi.mock('./a')"))
})

test('top: a template literal without substitutions is a static specifier', () => {
  const result = hoist('vi.mock(`./a`)\n', policy)
  assert.deepEqual(result.staticMocks[0]?.specifier, './a')
})

test('top: a mock inside a function is an error', () => {
  const result = hoist("function f() {\n  vi.mock('./a')\n}\n", policy)
  assert.deepEqual(errorCodes(result), ['HOIST_NOT_TOP_LEVEL'])
  assert.equal(result.diagnostics[0]?.message, 'vi.mock is not at the top level')
  assert.deepEqual(result.diagnostics[0]?.loc, { line: 2, column: 3 })
})

test('top: a mock inside a block statement is an error', () => {
  assert.deepEqual(errorCodes(hoist("if (x) { vi.mock('./a') }\n", policy)), [
    'HOIST_NOT_TOP_LEVEL',
  ])
})

test('top: a mock whose result is used is an error (it is not a statement)', () => {
  assert.deepEqual(errorCodes(hoist("const r = vi.mock('./a')\n", policy)), ['HOIST_NOT_TOP_LEVEL'])
})

test('top: a hoisted call inside another hoisted call is an error', () => {
  const result = hoist("vi.mock('./a', () => { vi.hoisted(() => 1) })\n", policy)
  assert.ok(errorCodes(result).includes('HOIST_NESTED'))
})

test('top: exporting a hoisted result is an error', () => {
  assert.deepEqual(errorCodes(hoist('export const x = vi.hoisted(() => 1)\n', policy)), [
    'HOIST_EXPORTED',
  ])
  assert.deepEqual(errorCodes(hoist('export default vi.hoisted(() => 1)\n', policy)), [
    'HOIST_EXPORTED',
  ])
})

test('top: exporting the result of a mock call is an error', () => {
  assert.deepEqual(errorCodes(hoist("export const x = vi.mock('./a')\n", policy)), [
    'HOIST_EXPORTED',
  ])
})

test('top: a call under a top-level guard is hoisted, wrapped in the guard', () => {
  const result = hoist("foo()\nif (import.meta.vitest) {\n  vi.mock('./a')\n}\nbar()\n", policy)
  assert.deepEqual(result.diagnostics, [])
  assertOrder(result.code, "if (import.meta.vitest) { vi.mock('./a'); }", 'foo()')
})

test('top: a guarded hoisted declaration becomes var', () => {
  const result = hoist(
    'foo()\nif (import.meta.vitest) {\n  const s = vi.hoisted(() => 1)\n}\n',
    policy,
  )
  assert.deepEqual(result.diagnostics, [])
  assert.ok(result.code.includes('var s = vi.hoisted('))
})

test('top: a call under some other condition is an error', () => {
  assert.deepEqual(errorCodes(hoist("if (other) {\n  vi.mock('./a')\n}\n", policy)), [
    'HOIST_NOT_TOP_LEVEL',
  ])
})

test('top: a vi that is not named vi or vitest is not a mock object', () => {
  const code = "foo()\nutils.mock('./a')\n"
  assertUntouched(code, hoist(code, policy))
})

test('top: a hit in a comment or a string costs a parse and changes nothing', () => {
  const code = "// vi.mock('./a')\nconst s = \"vi.mock('./b')\"\n"
  assertUntouched(code, hoist(code, policy))
})

test('top: code with no hoisted name comes back untouched', () => {
  const code = "import { a } from './a'\nexport const b = a\n"
  assertUntouched(code, hoist(code, policy))
})

test('top: a syntax error is a PARSE_ERROR diagnostic, not a throw', () => {
  const result = hoist("vi.mock('./a'\nfoo(\n", policy)
  assert.deepEqual(errorCodes(result), ['PARSE_ERROR'])
  assert.equal(result.code, "vi.mock('./a'\nfoo(\n")
  assert.equal(result.map, null)
})

test('top: a runner-module import stays first and static', () => {
  const result = hoist(
    "import { vi } from 'vitest'\nimport { a } from './a'\nfoo(a)\nvi.mock('./a')\n",
    policy,
  )
  assertOrder(
    result.code,
    "import { vi } from 'vitest'",
    "vi.mock('./a')",
    'const __provino_import_0__',
  )
  assert.equal(result.rewroteImports, true)
})
