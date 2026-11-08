// The import rewrite (D36), which both policies share: when a call moves to the top of a file
// with static imports, those imports become `await import()` placed after the hoisted block.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertOrder, hoist } from './test-helpers.ts'
import { blockPolicy, topLevelPolicy } from './test-policies.ts'

const MOCK = "jest.mock('./a')\n"

test('imports: a named import is read through the namespace', () => {
  const result = hoist(`import { x } from './a'\n${MOCK}use(x)\n`, blockPolicy)
  assert.equal(result.rewroteImports, true)
  assertOrder(
    result.code,
    MOCK.trim(),
    'const __provino_import_0__ = await __provino_import__("./a")',
    'use(__provino_import_0__.x)',
  )
})

test('imports: a default import is .default and an aliased name is the imported one', () => {
  const result = hoist(`import d, { x as y } from './a'\n${MOCK}use(d, y)\n`, blockPolicy)
  assert.ok(result.code.includes('use(__provino_import_0__.default, __provino_import_0__.x)'))
})

test('imports: a namespace import is the binding itself', () => {
  const result = hoist(`import * as ns from './a'\n${MOCK}use(ns.x)\n`, blockPolicy)
  assert.ok(result.code.includes('use(__provino_import_0__.x)'))
})

test('imports: a string-named import is read with brackets', () => {
  const result = hoist(`import { "a-b" as ab } from './a'\n${MOCK}use(ab)\n`, blockPolicy)
  assert.ok(result.code.includes('use(__provino_import_0__["a-b"])'))
})

test('imports: a shorthand property keeps its key', () => {
  const result = hoist(`import { x } from './a'\n${MOCK}use({ x, y: x })\n`, blockPolicy)
  assert.ok(result.code.includes('use({ x: __provino_import_0__.x, y: __provino_import_0__.x })'))
})

test('imports: uses inside functions, classes and typeof are rewritten', () => {
  const result = hoist(
    `import { Base, f } from './a'\n${MOCK}class A extends Base {}\nconst g = () => f()\nconst t = typeof f\n`,
    blockPolicy,
  )
  assert.ok(result.code.includes('class A extends __provino_import_0__.Base {}'))
  assert.ok(result.code.includes('() => (0, __provino_import_0__.f)()'))
  assert.ok(result.code.includes('typeof __provino_import_0__.f'))
})

test('imports: a shadowed name is left alone', () => {
  const result = hoist(
    `import { x } from './a'\n${MOCK}function f(x) { return x }\nconst g = () => { const x = 1; return x }\nuse(x)\n`,
    blockPolicy,
  )
  assert.ok(result.code.includes('function f(x) { return x }'))
  assert.ok(result.code.includes('const x = 1; return x'))
  assert.ok(result.code.includes('use(__provino_import_0__.x)'))
})

test('imports: export { x } of an imported binding is a getter, and leaves the export list', () => {
  const result = hoist(`import { x } from './a'\n${MOCK}export { x }\n`, blockPolicy)
  assert.ok(result.code.includes('__vite_ssr_exports__, "x"'))
  assert.ok(result.code.includes('get: () => __provino_import_0__.x'))
  assert.ok(result.code.includes('export {};'))
})

test('imports: export { x as y } of an imported binding keeps the exported name', () => {
  const result = hoist(`import { x } from './a'\n${MOCK}export { x as y }\n`, blockPolicy)
  assert.ok(result.code.includes('__vite_ssr_exports__, "y"'))
  assert.ok(result.code.includes('get: () => __provino_import_0__.x'))
})

test('imports: a named re-export becomes an import and a getter', () => {
  const result = hoist(`${MOCK}export { q as r } from './q'\n`, blockPolicy)
  assert.equal(result.rewroteImports, true)
  assert.ok(result.code.includes('const __provino_import_0__ = await __provino_import__("./q");'))
  assert.ok(result.code.includes('__vite_ssr_exports__, "r"'))
  assert.ok(result.code.includes('get: () => __provino_import_0__.q'))
  assert.ok(!result.code.includes('from "./q"'))
})

test('imports: export * as ns becomes an import and an export of the namespace', () => {
  const result = hoist(`${MOCK}export * as ns from './n'\n`, blockPolicy)
  assert.ok(result.code.includes('export { __provino_import_0__ as ns };'))
})

test('imports: a side-effect import becomes an awaited import', () => {
  const result = hoist(`import './setup'\n${MOCK}`, blockPolicy)
  assertOrder(result.code, MOCK.trim(), 'await __provino_import__("./setup")')
})

test('imports: import attributes are kept', () => {
  const result = hoist(
    `import data from './d.json' with { type: 'json' }\n${MOCK}use(data)\n`,
    blockPolicy,
  )
  assert.ok(
    result.code.includes('await __provino_import__("./d.json", { with: { type: \'json\' } })'),
  )
})

test('imports: numbering follows source order and the order is runner, hoisted, imports, rest', () => {
  const result = hoist(
    "import { a } from './a'\nimport { jest } from '@jest/globals'\nimport { b } from './b'\nuse(a, b)\njest.mock('./a')\njest.mock('./b')\n",
    blockPolicy,
  )
  assertOrder(
    result.code,
    "import { jest } from '@jest/globals'",
    "jest.mock('./a')",
    "jest.mock('./b')",
    'const __provino_import_0__ = await __provino_import__("./a")',
    'const __provino_import_1__ = await __provino_import__("./b")',
    'use(__provino_import_0__.a, __provino_import_1__.b)',
  )
})

test('imports: both policies rewrite, and a file with no static imports has nothing to rewrite', () => {
  assert.equal(
    hoist("import { a } from './a'\nvi.mock('./a')\nuse(a)\n", topLevelPolicy).rewroteImports,
    true,
  )
  const require = hoist("const a = require('./a')\njest.mock('./a')\nuse(a)\n", blockPolicy)
  assert.equal(require.rewroteImports, false)
  assertOrder(require.code, "jest.mock('./a')", "const a = require('./a')")
})

test('imports: a mock that is already first still gets the imports rewritten', () => {
  const result = hoist(`${MOCK}import { x } from './a'\nuse(x)\n`, blockPolicy)
  assert.equal(result.rewroteImports, true)
  assertOrder(
    result.code,
    MOCK.trim(),
    'await __provino_import__("./a")',
    'use(__provino_import_0__.x)',
  )
})

test('imports: export * becomes an awaited import and the module-runner helper call', () => {
  const result = hoist(`${MOCK}export * from './all'\n`, blockPolicy)
  assert.equal(result.rewroteImports, true)
  assert.ok(
    result.code.includes(
      'const __provino_import_0__ = await __provino_import__("./all");__vite_ssr_exportAll__(__provino_import_0__);',
    ),
  )
})

test('imports: a hashbang stays first', () => {
  const result = hoist(`#!/usr/bin/env node\nimport { x } from './a'\nuse(x)\n${MOCK}`, blockPolicy)
  assert.ok(result.code.startsWith('#!/usr/bin/env node\n'))
})

test('imports: a directive prologue stays first', () => {
  const result = hoist(`'use strict'\nuse()\n${MOCK}`, blockPolicy)
  assert.ok(result.code.startsWith("'use strict'\n"))
  assertOrder(result.code, "'use strict'", MOCK.trim(), 'use()')
})
