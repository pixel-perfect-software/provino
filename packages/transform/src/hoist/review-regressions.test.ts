// Rules the B13b pre-merge review found wrong against the real hoisters, one finding per group. The
// real outcome of each was read from `babel-plugin-jest-hoist` 30.5 and `@vitest/mocker` 5.0.5.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HoistPolicy } from '@provino/types'
import { hoistMocks } from './index.ts'
import { assertOrder, assertUntouched, errorCodes, hoist } from './test-helpers.ts'
import { blockPolicy, topLevelPolicy } from './test-policies.ts'

// `this` through a rewritten import ------------------------------------------------------------

const THIS_SOURCE =
  "import d, { f, tag } from './a'\nimport * as ns from './n'\njest.mock('./a')\nuse(f(), d(), tag`x`, f?.(), new f(), ns.g(), f.call(1))\n"

test('this: detached calls a named or default import with no receiver, as Babel does', () => {
  const { code } = hoist(THIS_SOURCE, blockPolicy)
  assert.ok(code.includes('(0, __provino_import_0__.f)()'), code)
  assert.ok(code.includes('(0, __provino_import_0__.default)()'), code)
  assert.ok(code.includes('(0, __provino_import_0__.tag)`x`'), code)
  assert.ok(code.includes('(0, __provino_import_0__.f)?.()'), code)
})

test('this: detached leaves everything that is not a bare call alone', () => {
  const { code } = hoist(THIS_SOURCE, blockPolicy)
  assert.ok(code.includes('new __provino_import_0__.f()'), code)
  assert.ok(code.includes('__provino_import_1__.g()'), code)
  assert.ok(code.includes('__provino_import_0__.f.call(1)'), code)
})

test('this: member keeps the namespace as the receiver, as hoistMocks.ts:313 does', () => {
  const { code } = hoist(
    "import { f, tag } from './a'\nvi.mock('./a')\nuse(f(), tag`x`)\n",
    topLevelPolicy,
  )
  assert.ok(code.includes('use(__provino_import_0__.f(), __provino_import_0__.tag`x`)'), code)
  assert.ok(!code.includes('(0, '), code)
})

// Names the base `ScopeTracker` resolves into the wrong scope (`scope.ts`) ---------------------

test('scope: a var in a function body is in the scope of a call beside it', () => {
  const result = hoist(
    'function g() { var k = 1; jest.mock("./m", () => k); use(k) }\n',
    blockPolicy,
  )
  assert.deepEqual(errorCodes(result), [])
  assertOrder(result.code, 'var k = 1', 'jest.mock("./m"', 'use(k)')
})

test('scope: a parameter default writes the outer name, not a var in the body', () => {
  const result = hoist(
    'let k = 1\nfunction f(a = (k = 2)) { var k; return a }\nfoo()\njest.mock("./m", () => k)\nuse(f)\n',
    blockPolicy,
  )
  assert.deepEqual(errorCodes(result), ['HOIST_FACTORY_OUT_OF_SCOPE'])
})

const BABEL_ONE_BINDING: readonly (readonly [string, string])[] = [
  [
    'a var of a parameter is the parameter',
    'function g(k) { var k = 1; jest.mock("./m", () => k) }\n',
  ],
  [
    'a var of a function expression’s own name is that name',
    'const g = function k() { var k = 1; jest.mock("./m", () => k) }\n',
  ],
  [
    'a var declared twice is written',
    'function g() { var k = 1; var k = 2; jest.mock("./m", () => k) }\n',
  ],
]

for (const [name, source] of BABEL_ONE_BINDING) {
  test(`scope: ${name}, so a factory can't read it`, () => {
    assert.deepEqual(errorCodes(hoist(source, blockPolicy)), ['HOIST_FACTORY_OUT_OF_SCOPE'])
  })
}

const BABEL_SEES_BINDING: readonly string[] = [
  'function f(a = () => { foo(); jest.mock("./x") }) { var jest; return a }\n',
  'function f(a = () => { foo(); jest.mock("./x") }) { let jest; return a }\n',
  'switch ((() => { foo(); jest.mock("./x") })()) { case 1: let jest = {}; use(jest) }\n',
]

for (const source of BABEL_SEES_BINDING) {
  test(`scope: the global mock object is shadowed as Babel's hasBinding reads it: ${source}`, () => {
    assertUntouched(source, hoist(source, blockPolicy))
  })
}

test('scope: a parameter default does not see a var in the body', () => {
  const { code } = hoist(
    "import { x } from './a'\njest.mock('./a')\nfunction f(a = x) { var x = 1; return a }\nconst g = (a = () => x) => { var x = 2; return a() }\n",
    blockPolicy,
  )
  assert.ok(code.includes('function f(a = __provino_import_0__.x) { var x = 1; return a }'), code)
  assert.ok(code.includes('(a = () => __provino_import_0__.x) => { var x = 2'), code)
})

test('scope: a parameter default still sees an earlier parameter of that name', () => {
  const { code } = hoist(
    "import { x } from './a'\njest.mock('./a')\nfunction f(x, a = x) { var x; return a }\n",
    blockPolicy,
  )
  assert.ok(code.includes('function f(x, a = x) { var x; return a }'), code)
})

test('scope: nested functions resolve past each one that hides the name', () => {
  const { code } = hoist(
    "import { x } from './a'\njest.mock('./a')\nfunction o(p = function (q = x) { var x }) { var x }\nfunction s(x) { function i(a = x) { var x } }\n",
    blockPolicy,
  )
  assert.ok(code.includes('function (q = __provino_import_0__.x) { var x }'), code)
  assert.ok(code.includes('function i(a = x) { var x }'), code)
})

test('scope: a switch discriminant does not see a declaration in its cases', () => {
  const { code } = hoist(
    "import { x } from './a'\njest.mock('./a')\nswitch (x) { case 1: let x = 1; use(x) }\n",
    blockPolicy,
  )
  assert.ok(code.includes('switch (__provino_import_0__.x) { case 1: let x = 1; use(x) }'), code)
})

// Reassignment is about the binding, not the name ----------------------------------------------

const CONSTANT: readonly string[] = [
  'let k = 1\nfunction f() { let k; k = 2 }\n',
  'let k = 1\nfunction f(k) { k++ }\n',
  'let k = 1\nfunction f() { k2 = 2; let k2 }\n',
  'let k = 1\nfunction f() { for (const k of xs) use(k) }\n',
]

for (const prelude of CONSTANT) {
  test(`reassigned: ${JSON.stringify(prelude)} leaves the outer k constant`, () => {
    const result = hoist(`${prelude}jest.mock('./m', () => k)\n`, blockPolicy)
    assert.deepEqual(errorCodes(result), [])
    assertOrder(result.code, 'let k = 1', "jest.mock('./m'")
  })
}

const REASSIGNED: readonly string[] = [
  'let k = 1\nk = 2\n',
  'let k = 1\nk++\n',
  'let k = 1\nfunction f() { k = 2 }\n',
  'let k = 1\nfunction f() { k = 2; { let k } }\n',
  'let k = 1\n;[k] = [2]\n',
  'let k = 1\n;[, [k]] = [2]\n',
  'let k = 1\n;[k = 3] = [2]\n',
  'let k = 1\n;[...k] = [2]\n',
  'let k = 1\n;({ k } = {})\n',
  'let k = 1\n;({ a: k } = {})\n',
  'let k = 1\n;({ a: { k = 1 } } = {})\n',
  'let k = 1\n;({ ...k } = {})\n',
  'let k = 1\nfor (k of []) {}\n',
  'let k = 1\nfor (k in {}) {}\n',
  'let k = 1\nfor ([k] of []) {}\n',
  'let k = 1\nfor ({ k } of []) {}\n',
  'var k = 1\nfor (var k of []) {}\n',
  'const k = 1\nk = 2\n',
]

for (const prelude of REASSIGNED) {
  test(`reassigned: ${JSON.stringify(prelude)} makes k out of scope`, () => {
    const result = hoist(`${prelude}jest.mock('./m', () => k)\n`, blockPolicy)
    assert.deepEqual(errorCodes(result), ['HOIST_FACTORY_OUT_OF_SCOPE'])
  })
}

// `export const` a factory reads ---------------------------------------------------------------

test('export const: a pure one a factory reads moves with the call, as Babel moves it', () => {
  const result = hoist("use()\nexport const a = 1\njest.mock('./m', () => a)\n", blockPolicy)
  assert.deepEqual(result.diagnostics, [])
  assertOrder(result.code, 'export const a = 1', "jest.mock('./m'", 'use()')
})

test('export const: an impure one is still out of scope', () => {
  const result = hoist("export const a = make()\njest.mock('./m', () => a)\n", blockPolicy)
  assert.deepEqual(errorCodes(result), ['HOIST_FACTORY_OUT_OF_SCOPE'])
})

// The prefilter --------------------------------------------------------------------------------

for (const [name, source] of [
  ['a block comment', "use()\njest.mock/* c */('./a')\n"],
  ['several comments and newlines', "use()\njest.mock // c\n/* d\n */ ('./a')\n"],
  ['a \\u escape', "use()\njest.m\\u006fck('./a')\n"],
] as const) {
  test(`prefilter: ${name} between or inside the name still reaches the parser`, () => {
    const result = hoist(source, blockPolicy)
    assert.deepEqual(
      result.staticMocks.map((call) => call.specifier),
      ['./a'],
    )
    assert.ok(result.code.indexOf('use()') > result.code.indexOf('./a'), result.code)
  })
}

test('prefilter: a name followed by a comment and no call is left alone', () => {
  const code = 'const mock = 1 /* c */\nuse(mock)\n'
  assertUntouched(code, hoist(code, blockPolicy))
})

// Failures are diagnostics ---------------------------------------------------------------------

test('failure: an error while applying is a coded diagnostic, with the input back', () => {
  const broken: HoistPolicy = {
    ...blockPolicy,
    get reExports(): never {
      throw new Error('boom')
    },
  }
  const code = "use()\njest.mock('./a')\n"
  const result = hoistMocks(code, broken, { filename: 'case.js' })
  assert.deepEqual(errorCodes(result), ['TRANSFORMER_FAILED'])
  assert.match(result.diagnostics[0]?.message ?? '', /case\.js.*boom/)
  assert.equal(result.code, code)
  assert.equal(result.map, null)
})

test('import(): an imported specifier is rewritten inside the unwrapped argument', () => {
  const result = hoist("import { p } from './a'\nvi.mock(import(p))\n", topLevelPolicy)
  assert.deepEqual(result.diagnostics, [])
  assert.ok(result.code.includes('vi.mock(__provino_import_0__.p)'), result.code)
})

test('import(): an awaited, longer expression is rewritten too', () => {
  const result = hoist(
    "import { p } from './a'\nvi.mock('./m')\nvi.doMock(await import(p + '/x'))\n",
    topLevelPolicy,
  )
  assert.deepEqual(result.diagnostics, [])
  assert.ok(result.code.includes("vi.doMock(__provino_import_0__.p + '/x')"), result.code)
})

// Diagnostic text ------------------------------------------------------------------------------

test('messages: a name holding replacement patterns prints as written', () => {
  const result = hoist("const $$x = f()\njest.mock('./a', () => $$x)\n", blockPolicy)
  assert.equal(result.diagnostics[0]?.message, 'out of scope: $$x in jest.mock')
})

test('messages: a nested call names both calls with their arguments, as upstream does', () => {
  const policy: HoistPolicy = {
    ...topLevelPolicy,
    messages: { ...topLevelPolicy.messages, HOIST_NESTED: 'Cannot call {call} inside {name}.' },
  }
  const result = hoist("vi.mock('./a', () => { vi.mock('./b') })\n", policy)
  assert.equal(result.diagnostics[0]?.code, 'HOIST_NESTED')
  assert.equal(result.diagnostics[0]?.message, "Cannot call vi.mock('./b') inside vi.mock('./a').")
  assert.deepEqual(result.diagnostics[0]?.loc, { line: 1, column: 24 })
})

test('messages: a hoisted value in a call with no literal argument prints empty parentheses', () => {
  const policy: HoistPolicy = {
    ...topLevelPolicy,
    messages: { ...topLevelPolicy.messages, HOIST_NESTED: 'Cannot call {call} inside {name}.' },
  }
  const result = hoist('const a = vi.hoisted(() => { vi.hoisted(() => 1) })\n', policy)
  assert.equal(result.diagnostics[0]?.message, 'Cannot call vi.hoisted() inside vi.hoisted().')
})

test('messages: nesting is reported ahead of the placement error the inner call also has', () => {
  const codes = errorCodes(hoist("vi.mock('./a', () => { vi.mock('./b') })\n", topLevelPolicy))
  assert.equal(codes[0], 'HOIST_NESTED')
})

test('messages: exporting a hoisted value has its own text, and a mock call keeps its own', () => {
  for (const source of [
    'export const x = vi.hoisted(() => 1)\n',
    'export const x = await vi.hoisted(() => 1)\n',
    'export default vi.hoisted(() => 1)\n',
    'export default await vi.hoisted(() => 1)\n',
  ]) {
    const result = hoist(source, topLevelPolicy)
    assert.deepEqual(errorCodes(result), ['HOIST_EXPORTED'], source)
    assert.equal(result.diagnostics[0]?.message, 'cannot export hoisted vi.hoisted', source)
  }
  const result = hoist("export const x = vi.mock('./a')\n", topLevelPolicy)
  assert.equal(result.diagnostics[0]?.message, 'cannot export the result of vi.mock')
})

// What Babel moves ------------------------------------------------------------------------------

for (const [name, source, first] of [
  ['an if with no block', 'foo()\nif (c) jest.mock("./a")\n', 'if (c) jest.mock("./a")'],
  [
    'its else branch',
    'foo()\nif (c) bar(); else jest.mock("./a")\n',
    'if (c) bar(); else jest.mock("./a")',
  ],
  ['a label', 'foo()\nl: jest.mock("./a")\n', 'l: jest.mock("./a")'],
  ['a loop body', 'foo()\nwhile (c) jest.mock("./a")\n', 'while (c) jest.mock("./a")'],
] as const) {
  test(`babel: ${name} moves whole, because getStatementParent finds a statement in a list`, () => {
    const result = hoist(source, blockPolicy)
    assert.deepEqual(result.diagnostics, [])
    assertOrder(result.code, first, 'foo()')
  })
}

test('babel: two calls under one if move it once', () => {
  const result = hoist(
    'foo()\nif (c) jest.mock("./a"); else jest.mock("./b")\nbar()\n',
    blockPolicy,
  )
  assertOrder(result.code, 'if (c) jest.mock("./a"); else jest.mock("./b")', 'foo()', 'bar()')
  // Whether either runs is only known when the `if` does, so neither is registered ahead of time.
  assert.deepEqual(result.staticMocks, [])
})

test('doMock: a file whose only mock call is doMock still rewrites its imports, as Vitest does', () => {
  // `hasMockApiCall` in hoistMocks.ts L405. A static re-export then loads ahead of the imports.
  const result = hoist(
    "import a from './a'\nimport { vi } from 'vitest'\nexport { r } from './r'\nuse(a)\nvi.doMock('./d')\n",
    topLevelPolicy,
  )
  assert.equal(result.rewroteImports, true)
  assertOrder(
    result.code,
    "import { vi } from 'vitest'",
    'const __provino_import_0__ = await import("./a")',
    "export { r } from './r'",
    'use(__provino_import_0__.default)',
    "vi.doMock('./d')",
  )
})

test('doMock: a policy with no import() calls leaves doMock files alone', () => {
  const code = "import a from './a'\nuse(a)\njest.doMock('./d')\n"
  assertUntouched(code, hoist(code, blockPolicy))
})

test('babel: a statement in a switch case stays, because a case is not a block', () => {
  const code = 'switch (1) { case 1: foo(); jest.mock("./a") }\n'
  assertUntouched(code, hoist(code, blockPolicy))
})

test('babel: a computed member of a runner namespace is the mock object', () => {
  const result = hoist(
    'import * as G from "@jest/globals"\nfoo()\nG["jest"].mock("./a")\n',
    blockPolicy,
  )
  assertOrder(result.code, 'G["jest"].mock("./a")', 'foo()')
})

test('babel: a computed member with any other key is not', () => {
  const code =
    'import * as G from "@jest/globals"\nfoo()\nG["other"].mock("./a")\nG[k].mock("./a")\n'
  assertUntouched(code, hoist(code, blockPolicy))
})

// Optional calls -------------------------------------------------------------------------------

for (const code of [
  "vi?.mock('./a')\n",
  "vi.mock?.('./a')\n",
  'use()\nvi?.hoisted(() => 1)\n',
] as const) {
  test(`optional: ${JSON.stringify(code)} is left alone, as real Vitest leaves it`, () => {
    assertUntouched(code, hoist(code, topLevelPolicy))
  })
}

for (const code of ["use()\njest?.mock('./a')\n", "use()\njest.mock?.('./a')\n"] as const) {
  test(`optional: ${JSON.stringify(code)} stays put, as real Babel leaves it`, () => {
    assertUntouched(code, hoist(code, blockPolicy))
  })
}
