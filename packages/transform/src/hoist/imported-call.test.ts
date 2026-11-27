// `HoistPolicy.importedCalls` (B27j): the call is a named import itself (`mock('./a')` after
// `import { mock } from 'runner'`), the shape of the native API's `mock` (`nativeHoistPolicy` in
// `@provino/policy`). Recognition is by binding, never by name.
import assert from 'node:assert/strict'
import type { HoistPolicy } from '@provino/types'
import { test } from 'provino'
import { prefilterFor } from './prefilter.ts'
import { assertOrder, assertUntouched, errorCodes, hoist } from './test-helpers.ts'
import { blockPolicy, importedCallPolicy as policy } from './test-policies.ts'

const RUNNER = "import { expect, mock } from 'runner'\n"

test('imported call: mock moves above the imports, which become late imports', () => {
  const code = `${RUNNER}import { a } from './a'\nuse(a)\nmock('./a', () => ({ a: 1 }))\n`
  const result = hoist(code, policy)
  assert.deepEqual(result.diagnostics, [])
  assert.equal(result.rewroteImports, true)
  assertOrder(
    result.code,
    "import { expect, mock } from 'runner'",
    "mock('./a', () => ({ a: 1 }))",
    'const __provino_import_0__ = await __provino_import__("./a")',
    'use(__provino_import_0__.a)',
  )
  assert.deepEqual(
    result.staticMocks.map(({ method, specifier, hasFactory, automock }) => ({
      method,
      specifier,
      hasFactory,
      automock,
    })),
    [{ method: 'mock', specifier: './a', hasFactory: true, automock: false }],
  )
})

test('imported call: unmock hoists too, and an automock is one argument', () => {
  const result = hoist(
    `import { mock, unmock } from 'runner'\nfoo()\nmock('./a')\nunmock('./b')\n`,
    policy,
  )
  assertOrder(result.code, "mock('./a')", "unmock('./b')", 'foo()')
  assert.deepEqual(
    result.staticMocks.map(({ method, automock }) => [method, automock]),
    [
      ['mock', true],
      ['unmock', true],
    ],
  )
})

test('imported call: a renamed import hoists under its own name, and the prefilter sees it', () => {
  const code = "import { mock as m } from 'runner'\nfoo()\nm('./a')\n"
  assert.ok(prefilterFor(policy)?.test(code))
  const result = hoist(code, policy)
  assertOrder(result.code, "m('./a')", 'foo()')
  assert.deepEqual(
    result.staticMocks.map(({ method }) => method),
    ['mock'],
  )
})

test("imported call: a namespace import's member hoists, computed too", () => {
  const result = hoist("import * as r from 'runner'\nfoo()\nr.mock('./a')\n", policy)
  assertOrder(result.code, "r.mock('./a')", 'foo()')
  const computed = "import * as r from 'runner'\nfoo()\nr['mock']('./a')\n"
  assert.ok(prefilterFor(policy)?.test(computed))
  assertOrder(hoist(computed, policy).code, "r['mock']('./a')", 'foo()')
  // A namespace member that is not one of the calls stays.
  const other = "import * as r from 'runner'\nfoo()\nr['fn']('./a')\n"
  assertUntouched(other, hoist(other, policy))
})

test('imported call: a string export name and a comment before `as` still hoist', () => {
  for (const code of [
    "import { 'mock' as m } from 'runner'\nfoo()\nm('./a')\n",
    "import { mock /* c */ as m } from 'runner'\nfoo()\nm('./a')\n",
    "import { mock//\nas m } from 'runner'\nfoo()\nm('./a')\n",
  ]) {
    assert.ok(prefilterFor(policy)?.test(code), code)
    assertOrder(hoist(code, policy).code, "m('./a')", 'foo()')
  }
})

test('imported call: a file that never names the module is not parsed', () => {
  // `sinon.mock(` and an ANSI escape would pass a dialect's prefilter; without 'runner' this doesn't.
  const code = `const s = sinon.mock(api)\nmock('./a')\nconst red = '@@u001b[31m'\n`.replaceAll(
    '@@',
    String.fromCharCode(92),
  )
  assert.equal(prefilterFor(policy)?.test(code), false)
  assertUntouched(code, hoist(code, policy))
  // With the module named but no call's name anywhere, it isn't parsed either.
  assert.equal(prefilterFor(policy)?.test("import { expect } from 'runner'\nexpect(1)\n"), false)
})

test('imported call: a file that names the module but imports no call is left as it was', () => {
  const code = "import { expect } from 'runner'\n// mock('./a')\nfoo()\n"
  assert.ok(prefilterFor(policy)?.test(code))
  assertUntouched(code, hoist(code, policy))
})

test('imported call: a mock of another module, a local mock and an unimported mock stay', () => {
  for (const code of [
    "import { mock } from 'elsewhere'\nfoo()\nmock('./a')\n",
    "function mock(p) {}\nfoo()\nmock('./a')\n",
    "foo()\nmock('./a')\n",
    "import { fn } from 'runner'\nfoo()\nfn('./a')\n",
  ]) {
    assertUntouched(code, hoist(code, policy))
  }
})

test('imported call: a shadowing binding in scope is not the import', () => {
  const code = "import { mock } from 'runner'\nfunction f(mock) { mock('./a') }\n"
  assertUntouched(code, hoist(code, policy))
})

test('imported call: an optional call is not a candidate', () => {
  const code = "import { mock } from 'runner'\nfoo()\nmock?.('./a')\n"
  assertUntouched(code, hoist(code, policy))
})

test('imported call: a call inside a function is HOIST_NOT_TOP_LEVEL, named as written', () => {
  const result = hoist("import { mock as m } from 'runner'\ntest(() => { m('./a') })\n", policy)
  assert.deepEqual(errorCodes(result), ['HOIST_NOT_TOP_LEVEL'])
  assert.match(result.diagnostics[0]?.message ?? '', /^m is not at the top level/)
})

test('imported call: a mock inside another is HOIST_NESTED, each with its argument', () => {
  const result = hoist("import { mock } from 'runner'\nmock('./a', () => mock('./b'))\n", policy)
  assert.deepEqual(errorCodes(result), ['HOIST_NESTED', 'HOIST_NOT_TOP_LEVEL'])
  assert.match(result.diagnostics[0]?.message ?? '', /^mock\('\.\/b'\) is inside/)
})

test('imported call: exporting the result is HOIST_EXPORTED', () => {
  const result = hoist("import { mock } from 'runner'\nexport const x = mock('./a')\n", policy)
  assert.deepEqual(errorCodes(result), ['HOIST_EXPORTED'])
})

test('imported call: under enclosing-block placement the call moves to its block', () => {
  const block = {
    ...blockPolicy,
    importedCalls: [{ module: 'runner', exportName: 'mock' }],
    runnerModules: ['runner'],
  }
  const result = hoist(
    "import { mock } from 'runner'\nfoo()\nif (c) { bar()\nmock('./a') }\n",
    block,
  )
  assertOrder(result.code, 'foo()', "{ mock('./a')", 'bar()')
  assert.deepEqual(result.diagnostics, [])
})

test('imported call: a policy without the matcher costs nothing new', () => {
  const code = "import { mock } from 'runner'\nfoo()\nmock('./a')\n"
  assertUntouched(code, hoist(code, blockPolicy))
})

// `HoistPolicy.callbackScopes` (B28): the callback of such a call is a scope of its own, so a
// hoisted call in it moves to the top of the callback (the native `isolateModules`).
const scoped: HoistPolicy = {
  ...policy,
  callbackScopes: [
    { module: 'runner', exportName: 'isolate' },
    { module: 'runner', exportName: 'isolateAsync' },
  ],
}

test('callback scope: a mock in the callback moves to its top, and the imports stay static', () => {
  const code =
    "import { isolate, mock } from 'runner'\nimport { a } from './a'\nisolate(() => {\n  const m = load('./b')\n  mock('./b', () => ({ b: 1 }))\n  return m\n})\nuse(a)\n"
  const result = hoist(code, scoped)
  assert.deepEqual(result.diagnostics, [])
  assert.equal(result.rewroteImports, false)
  assertOrder(
    result.code,
    "import { a } from './a'",
    'isolate(() => {',
    "mock('./b', () => ({ b: 1 }))",
    "const m = load('./b')",
    'use(a)',
  )
  assert.deepEqual(
    result.staticMocks.map(({ method, specifier }) => [method, specifier]),
    [['mock', './b']],
  )
})

test('callback scope: a function expression, an async callback, a renamed import and a namespace member', () => {
  for (const code of [
    "import { isolate, mock } from 'runner'\nisolate(function () {\n  foo()\n  mock('./b')\n})\n",
    "import { isolateAsync as iso, mock } from 'runner'\niso(async () => {\n  foo()\n  mock('./b')\n})\n",
    "import * as r from 'runner'\nr.isolate(() => {\n  foo()\n  r.mock('./b')\n})\n",
  ]) {
    const result = hoist(code, scoped)
    assert.deepEqual(result.diagnostics, [], code)
    assertOrder(result.code, "mock('./b')", 'foo()')
  }
})

test('callback scope: nested in a test, the callback is still its own scope', () => {
  const code =
    "import { isolate, mock } from 'runner'\nit('x', () => {\n  isolate(() => {\n    foo()\n    mock('./b')\n  })\n})\n"
  const result = hoist(code, scoped)
  assert.deepEqual(result.diagnostics, [])
  assertOrder(result.code, "it('x', () => {", 'isolate(() => {', "mock('./b')", 'foo()')
})

test('callback scope: anywhere else in the callback, or with no such policy, is still not top level', () => {
  for (const code of [
    // Deeper than the callback's own body.
    "import { isolate, mock } from 'runner'\nisolate(() => {\n  if (c) {\n    mock('./b')\n  }\n})\n",
    // Not the first argument.
    "import { isolate, mock } from 'runner'\nisolate(x, () => {\n  mock('./b')\n})\n",
    // The same name, not imported from the module.
    "import { mock } from 'runner'\nconst isolate = (f) => f()\nisolate(() => {\n  mock('./b')\n})\n",
  ]) {
    assert.deepEqual(errorCodes(hoist(code, scoped)), ['HOIST_NOT_TOP_LEVEL'], code)
  }
  const plain = "import { isolate, mock } from 'runner'\nisolate(() => {\n  mock('./b')\n})\n"
  assert.deepEqual(errorCodes(hoist(plain, policy)), ['HOIST_NOT_TOP_LEVEL'])
})
