// Provino's own hoist inputs, run through the same real hoisters as the vendored upstream ones. The
// 12 upstream Jest inputs and 96 upstream Vitest ones don't reach most of `HoistPolicy`: Jest's have
// no const, chain, alias, namespace, non-runner import, re-export, bad argument or out-of-scope
// factory. These do. Nothing here states an expected result: the real hoisters say it, live.
//
// Left out because the real hoister crashes, not because ours has a rule:
// - `const o = 1, p = 2; jest.mock('a', () => o)`: Babel's plugin throws on the removed declarator.
// - `export * as n from` under Jest: Babel's CommonJS step throws without
//   `@babel/plugin-transform-export-namespace-from`, which babel-jest's preset doesn't add.
// - `vi.mock()` and `vi.doMock()` with no argument: Vitest reads `node.arguments[0].type` and throws
//   a raw `TypeError`.
//
// Left out under Vitest only, because its output has a bug ours fixes (D7), and the Jest twin of each
// input proves the fix:
// - `function f(a = x) { var x = 1; return a }`: the walker skips `x`, the import is gone, and the
//   run hits a `ReferenceError`.
// - `import b from "./b"\n;[1].forEach(f)`: the moved node takes the `;` with it, so `[1]` joins the
//   line before. The generator closes such statements itself for the same reason.
import { type HoistCase, plainCase } from './check.ts'

function group(prefix: string, cases: Readonly<Record<string, string>>): readonly HoistCase[] {
  // A trailing newline, as a file has: without one, Vitest moves the last call with no line end, and
  // what it prints doesn't parse.
  return Object.entries(cases).map(([name, code]) =>
    plainCase(`${prefix}: ${name}`, code.endsWith('\n') ? code : `${code}\n`),
  )
}

const jsxCase = (name: string, code: string, filename: string): HoistCase => ({
  name,
  code,
  filename,
  jsx: 'automatic',
})

export const JEST_INPUTS: readonly HoistCase[] = [
  ...group('const', {
    'a pure const a factory reads moves':
      'const a = "x"\nfoo()\njest.mock("./m", () => a)\nimport y from "./m"\ny()',
    'a pure const read at import is live when the factory runs':
      'import y from "./m"\nconst a = 1\njest.mock("./m", () => ({ v: a }))\nuse(y)',
    'a const built from a mock-named const':
      'const mockA = "x"\nconst b = mockA + 1\njest.mock("./m", () => b)',
    'an impure const is out of scope': 'const a = foo()\njest.mock("./m", () => a)',
    'an exported const moves':
      'export const a = 1\nfoo()\njest.mock("./m", () => a)\nimport y from "./m"\nuse(y)',
    'an exported const stays exported': 'export const a = 1\njest.mock("./m", () => a)',
    'a destructured const': 'foo()\nconst { a } = { a: 1 }\njest.mock("./m", () => a)',
    'an array-destructured const': 'foo()\nconst [a] = [1]\njest.mock("./m", () => a)',
    'an unassigned let moves': 'foo()\nlet k = 1\njest.mock("./m", () => k)',
    'an unassigned var moves': 'foo()\nvar k = 1\njest.mock("./m", () => k)',
    'a reassigned let is out of scope': 'let k = 1\nk = 2\njest.mock("./m", () => k)',
    'a let updated with ++ is out of scope': 'let k = 1\nk++\njest.mock("./m", () => k)',
    'a let assigned by destructuring is out of scope':
      'let k = 1\n;[k] = [2]\njest.mock("./m", () => k)',
    'a let assigned as a for-of head is out of scope':
      'let k = 1\nfor (k of []) foo()\njest.mock("./m", () => k)',
    'a var beside the call in a function body moves':
      'function g() { var k = 1; jest.mock("./m", () => k); use(k) }\ng()',
    'a parameter default writes the outer name, not a var in the body':
      'let k = 1\nfunction f(a = (k = 2)) { var k; return a }\nfoo()\njest.mock("./m", () => k)\nuse(f)',
    'a shadow reassigned in a function is not the same name':
      'let k = 1\nfunction f() { let k; k = 2; return k }\nfoo()\njest.mock("./m", () => k)\nuse(f)',
    'a factory parameter shadows a const': 'const a = foo()\njest.mock("./m", (a) => a)',
    'a local in the factory shadows a const':
      'const a = foo()\njest.mock("./m", () => { const a = 1; return a })',
    'a const in a function body moves to that body':
      'function f() {\n  foo()\n  const inner = 1\n  jest.mock("./m", () => inner)\n}\nf()',
    'a const in a function body declared below the call':
      'function f() {\n  foo()\n  jest.mock("./m", () => inner)\n  const inner = 1\n}\nf()',
    'a const in an outer scope is out of scope':
      'const outer = 1\nfunction f() {\n  jest.mock("./m", () => outer)\n}\nf()',
    'an allow-listed name bound locally is a const':
      'foo()\nconst console = 1\njest.mock("./m", () => console)',
    'two consts keep their source order':
      'foo()\nconst a = 1\nconst b = 2\njest.mock("./m", () => [a, b])',
    'a template literal const': 'foo()\nconst a = `x`\njest.mock("./m", () => a)',
    'an object of literals is pure': 'foo()\nconst a = { b: [1, "c"] }\njest.mock("./m", () => a)',
    'a function expression const is pure': 'foo()\nconst a = () => 1\njest.mock("./m", () => a)',
  }),
  ...group('factory', {
    'an unknown global is out of scope': 'foo()\njest.mock("a", () => someGlobal)',
    'an allow-listed global': 'foo()\njest.mock("a", () => process.env.X)',
    'another allow-listed global': 'foo()\njest.mock("a", () => Math.max(1, 2))',
    'a mock-prefixed name': 'foo()\njest.mock("a", () => mockThing)',
    'a mock-prefixed name of any case': 'foo()\njest.mock("a", () => MOCKED)',
    'a coverage variable': 'foo()\njest.mock("a", () => cov_1abc)',
    'a double-underscore coverage variable': 'foo()\njest.mock("a", () => __coverage__)',
    'a capitalized Cov is not coverage': 'foo()\njest.mock("a", () => Cov_1)',
    'a function declaration is out of scope':
      'function helper() {}\nfoo()\njest.mock("a", () => helper)',
    'a mock-prefixed function declaration':
      'function mockHelper() {}\nfoo()\njest.mock("a", () => mockHelper)',
    'a class is out of scope': 'class Helper {}\nfoo()\njest.mock("a", () => Helper)',
    'an import is out of scope': 'import y from "./y"\nfoo()\njest.mock("a", () => y)',
    'a mock-prefixed import': 'import mockY from "./y"\nfoo()\njest.mock("a", () => mockY)',
    'the runner import inside a factory':
      'import { jest } from "@jest/globals"\nfoo()\njest.mock("a", () => jest.fn())',
    'a function factory': 'foo()\njest.mock("a", function () { return 1 })',
    'an async factory': 'foo()\njest.mock("a", async () => ({}))',
    'a factory and options': 'foo()\njest.mock("a", () => ({}), { virtual: true })',
    'a factory that loads the original': 'foo()\njest.mock("a", () => jest.requireActual("a"))',
    'a factory with a parameter': 'foo()\njest.mock("a", (original) => original)',
    'a factory that requires': 'foo()\njest.mock("a", () => require("b"))',
    'a factory that imports': 'foo()\njest.mock("a", () => import("b"))',
    'a mock var read at load is in its TDZ':
      'import y from "./m"\njest.mock("./m", () => mockX)\nconst mockX = 1\nuse(y)',
  }),
  ...group('argument', {
    'mock: no arguments stays': 'foo()\njest.mock()',
    'mock: one identifier stays': 'foo()\njest.mock(x)',
    'mock: one string': 'foo()\njest.mock("a")',
    'mock: a number': 'foo()\njest.mock(1)',
    'mock: a template': 'foo()\njest.mock(`a`)',
    'mock: a template with an expression': `foo()\njest.mock(\`a\${b}\`)`,
    'mock: a dynamic import stays': 'foo()\njest.mock(import("./p"))',
    'mock: a second argument that is a name': 'foo()\njest.mock("a", notFn)',
    'mock: a second argument that is undefined': 'foo()\njest.mock("a", undefined)',
    'mock: a second argument that is an object': 'foo()\njest.mock("a", {})',
    'mock: an identifier path and a factory': 'foo()\njest.mock(x, () => ({}))',
    'mock: four arguments stay': 'foo()\njest.mock("a", () => ({}), {}, 4)',
    'unmock: a string': 'foo()\njest.unmock("a")',
    'unmock: no arguments stays': 'foo()\njest.unmock()',
    'unmock: an identifier stays': 'foo()\njest.unmock(x)',
    'unmock: a template stays': 'foo()\njest.unmock(`a`)',
    'unmock: two arguments stay': 'foo()\njest.unmock("a", "b")',
    'deepUnmock: a string': 'foo()\njest.deepUnmock("a")',
    'deepUnmock: an identifier stays': 'foo()\njest.deepUnmock(x)',
    'enableAutomock: no arguments': 'foo()\njest.enableAutomock()',
    'enableAutomock: an argument stays': 'foo()\njest.enableAutomock(1)',
    'disableAutomock: no arguments': 'foo()\njest.disableAutomock()',
    'disableAutomock: an argument stays': 'foo()\njest.disableAutomock(1)',
    'doMock never moves': 'foo()\njest.doMock("a")',
    'dontMock never moves': 'foo()\njest.dontMock("a")',
    'hoisted is not a Jest call': 'foo()\njest.hoisted(() => 1)',
  }),
  ...group('chain', {
    'two mocks': 'foo()\njest.mock("a").mock("b")\nbar()',
    'three methods': 'foo()\njest.mock("a").unmock("b").deepUnmock("c")',
    'automock then mock': 'foo()\njest.enableAutomock().mock("a")',
    'a non-hoisting link at the end stays': 'foo()\njest.mock("a").doMock("b")',
    'a non-hoisting link at the start stays': 'foo()\njest.doMock("b").mock("a")',
    'a bad argument in a link stays': 'foo()\njest.mock("a").mock(x)',
    'a factory in a link': 'foo()\njest.mock("a", () => ({})).mock("b")',
    'an out-of-scope factory in a link': 'foo()\njest.mock("a", () => nope).mock("b")',
  }),
  ...group('object', {
    'an aliased import':
      'import { jest as j } from "@jest/globals"\nimport a from "./a"\na()\nj.mock("./a")',
    'an aliased import in a factory':
      'import { jest as j } from "@jest/globals"\nfoo()\nj.mock("./a", () => j.fn())',
    'a namespace import':
      'import * as G from "@jest/globals"\nimport a from "./a"\na()\nG.jest.mock("./a")',
    'a namespace member other than jest':
      'import * as G from "@jest/globals"\nfoo()\nG.expect.mock("./a")',
    'a computed namespace member':
      'import * as G from "@jest/globals"\nfoo()\nG["jest"].mock("./a")',
    'a default import': 'import G from "@jest/globals"\nfoo()\nG.jest.mock("./a")',
    'jest from a non-runner module': 'import { jest } from "./my-jest"\nfoo()\njest.mock("a")',
    'a namespace of a non-runner module': 'import * as G from "./my-jest"\nfoo()\nG.jest.mock("a")',
    'a local const named jest': 'const jest = { mock() {} }\nfoo()\njest.mock("a")',
    'a parameter named jest': 'function f(jest) {\n  foo()\n  jest.mock("a")\n}\nf({ mock() {} })',
    'a required jest': 'const { jest } = require("@jest/globals")\nfoo()\njest.mock("a")',
    'another object': 'foo()\nother.mock("a")',
    'a member of another object': 'foo()\nother.jest.mock("a")',
    'vi is nothing to Jest': 'foo()\nvi.mock("a")',
    'a computed method': 'foo()\njest["mock"]("a")',
    'an optional call': 'foo()\njest.mock?.("a")',
    'an optional member': 'foo()\njest?.mock("a")',
    'parentheses around the call': 'foo()\n(jest.mock("a"))',
    'parentheses after a semicolon': 'foo();\n(jest.mock("a"))',
    'a comment before the call parens': 'foo()\njest.mock/* c */("./a")',
    'an escape in the object name': 'foo()\nj\\u0065st.mock("./a")',
    'a mock call in a string': 'const s = "jest.mock(\'./a\')"\nuse(s)',
    'the result used': 'foo()\nconst r = jest.mock("a")\nuse(r)',
    'the result awaited': 'foo()\nawait jest.mock("a")',
  }),
  ...group('import', {
    'non-runner imports load after the call':
      'import a from "./a"\nimport b from "./b"\nuse(a, b)\njest.mock("./b")',
    'a side-effect import': 'import "./side"\nfoo()\njest.mock("./side")',
    'an empty named import': 'import {} from "./side"\nfoo()\njest.mock("./side")',
    'two imports of one module':
      'import a from "./a"\nimport { b } from "./a"\nuse(a, b)\njest.mock("./a")',
    'an import below the call': 'jest.mock("./a")\nimport a from "./a"\nuse(a)',
    'an import attribute':
      'import j from "./j.json" with { type: "json" }\nuse(j)\njest.mock("./j.json")',
    'runner imports stay':
      'import { expect } from "@jest/globals"\nimport a from "./a"\nexpect(a)\njest.mock("./a")',
    'a dynamic import after the call':
      'function f() { return import("./a") }\njest.mock("./a")\nf()',
    'a dynamic specifier': 'function f(x) { return import(x) }\njest.mock("./a")\nf("./b")',
    'a dynamic require': 'function f(x) { return require(x) }\njest.mock("./a")\nf("./b")',
    'no mock call': 'import a from "./a"\nuse(a)',
    'an unmock of an import': 'import a from "./a"\nuse(a)\njest.unmock("./a")',
  }),
  ...group('binding', {
    'default, named and namespace':
      'import d, { n } from "./x"\nimport * as ns from "./y"\njest.mock("./x")\nuse(d, n, ns, ns.z)',
    'an aliased named import': 'import { n as m } from "./x"\njest.mock("./x")\nuse(m)',
    'a string-named import': 'import { "a b" as q } from "./x"\njest.mock("./x")\nuse(q)',
    'shorthand in an object':
      'import d, { x as z } from "./x"\nconst o = { d, z }\njest.mock("./x")\nuse(o)',
    'shorthand with a default in a pattern':
      'import { x } from "./x"\nconst { y = x } = obj\njest.mock("./x")\nuse(y)',
    'typeof an import': 'import { x } from "./x"\njest.mock("./x")\nuse(typeof x)',
    'a computed key': 'import { x } from "./x"\njest.mock("./x")\nuse({ [x]: 1 }, other[x])',
    'a class field and method':
      'import { x } from "./x"\njest.mock("./x")\nclass K { a = x; m() { return x } }\nuse(new K().a, new K().m())',
    'extends an import': 'import { B } from "./x"\njest.mock("./x")\nclass K extends B {}\nuse(K)',
    'a test callback': 'import { x } from "./x"\njest.mock("./x")\ntest("t", () => { use(x) })',
    'a parameter shadows an import':
      'import { x } from "./x"\njest.mock("./x")\nfunction f(x) { return x }\nuse(f(1))',
    'a local shadows an import':
      'import { x } from "./x"\njest.mock("./x")\n{ const x = 1; use(x) }',
    'a default parameter with an inner var':
      'import { x } from "./x"\njest.mock("./x")\nfunction f(a = x) { var x = 1; return a }\nuse(f())',
    'a switch with a local in a case':
      'import { x } from "./x"\njest.mock("./x")\nswitch (x) { case 1: let x = 1; use(x) }',
    'a function called later reads the binding':
      'import { x } from "./x"\njest.mock("./x")\nfunction f() { return x }\nuse(f())',
    'an exported function reads the binding':
      'import { x } from "./x"\njest.mock("./x")\nexport function f() { return x }',
    'export default of an import': 'import { x } from "./x"\njest.mock("./x")\nexport default x',
  }),
  ...group('this', {
    'a bare call through an import': 'import { f } from "./a"\njest.mock("./a")\nf()',
    'a default import called': 'import f from "./a"\njest.mock("./a")\nf()',
    'a method on an import keeps its receiver': 'import { o } from "./a"\njest.mock("./a")\no.m()',
    'a namespace method keeps the namespace': 'import * as ns from "./a"\njest.mock("./a")\nns.f()',
    'a tagged template': 'import { f } from "./a"\njest.mock("./a")\nf`x`',
    'a new': 'import { F } from "./a"\njest.mock("./a")\nnew F()',
    'a nested call': 'import { f, g } from "./a"\njest.mock("./a")\nf(g())',
    'an optional call': 'import { f } from "./a"\njest.mock("./a")\nf?.()',
  }),
  ...group('re-export', {
    'a named re-export': 'export { x as y } from "./x"\njest.mock("./x")',
    'the same name': 'export { x } from "./x"\njest.mock("./x")',
    'a default re-export': 'export { default } from "./x"\njest.mock("./x")',
    'a default re-exported as a name': 'export { default as d } from "./x"\njest.mock("./x")',
    'a star': 'export * from "./x"\njest.mock("./x")',
    'an import exported': 'import { x } from "./x"\nexport { x as y }\njest.mock("./x")',
    'an import exported by name': 'import { x } from "./x"\nexport { x }\njest.mock("./x")',
    'a default exported': 'import d from "./x"\nexport { d }\njest.mock("./x")',
    'a namespace exported': 'import * as n from "./x"\nexport { n }\njest.mock("./x")',
    'an import exported and read':
      'import { x } from "./x"\nexport { x }\nuse(x)\njest.mock("./x")',
    'imports and re-exports in order':
      'import a from "./a"\nexport { b } from "./b"\nimport c from "./c"\nuse(a, c)\njest.mock("./b")',
    'a local export beside a mock':
      'export const v = foo()\nexport function g() {}\nexport default 1\njest.mock("./x")',
  }),
  ...group('block', {
    'a function body': 'function f() {\n  foo()\n  jest.mock("./a")\n  require("./a")\n}\nf()',
    'an arrow callback': 'beforeEach(() => {\n  require("x")\n  jest.mock("./a")\n})',
    'an if block': 'if (c) {\n  foo()\n  jest.mock("./a")\n}',
    'an if without a block stays': 'foo()\nif (c) jest.mock("./a")',
    'a static block': 'class A { static { foo(); jest.mock("./a"); } }',
    'a switch case stays': 'switch (1) { case 1: foo(); jest.mock("./a"); }',
    'a try block': 'try {\n  foo()\n  jest.mock("./a")\n} catch {}',
    'a plain block': '{\n  foo()\n  jest.mock("./a")\n}',
    'a label stays': 'foo()\nl: jest.mock("./a")',
    'a nested mock in a factory':
      'jest.mock("./a", () => {\n  foo()\n  jest.mock("./b")\n  return {}\n})',
    'a doMock in a factory':
      'foo()\njest.mock("./a", () => {\n  jest.doMock("./b")\n  return {}\n})',
    'two blocks stay apart':
      'function f() {\n  foo()\n  jest.mock("./a")\n}\nfunction g() {\n  foo()\n  jest.mock("./a")\n}\nf()\ng()',
    'a block hoist leaves imports alone':
      'import a from "./a"\nfunction f() {\n  foo()\n  jest.mock("./a")\n}\nuse(a, f)',
    'a program and a block hoist':
      'import a from "./a"\nfunction f() {\n  foo()\n  jest.mock("./b")\n}\njest.mock("./a")\nuse(a, f())',
  }),
  ...group('layout', {
    'mock, unmock, require, mock':
      'jest.mock("./a")\njest.unmock("./a")\nconst x = require("./x")\nuse(x)\njest.mock("./c")',
    'a stayer between imports':
      'import a from "./a"\nimport b from "./b"\nconst z = 1\nimport c from "./c"\njest.mock("./b")\nuse(a, b, c, z)',
    'a call already first': 'jest.mock("./a")\nimport a from "./a"\nuse(a)',
    'the statement touching the anchor':
      'import a from "./a"\nconst z = 1;jest.mock("./a")\nuse(a, z)',
    'a call then a stayer with no newline': 'jest.mock("./a");foo();jest.mock("./b")',
    'a leading semicolon and an array': 'const a = 1\njest.mock("./x")\n;[1, 2].forEach(f)\nuse(a)',
    'a leading semicolon and a paren': 'const a = 1\njest.mock("./x")\n;(f)()\nuse(a)',
    'a leading semicolon and a template': 'const a = f\njest.mock("./x")\n;`t`.length\nuse(a)',
    'an import carrying its semicolon':
      'const a = 1\nimport b from "./b"\n;[1].forEach(f)\njest.mock("./b")\nuse(a, b)',
    'CRLF line endings': 'import a from "./a"\r\nfoo()\r\njest.mock("./a")\r\nuse(a)\r\n',
    'a comment after the call': 'foo()\njest.mock("./a") // why\nbar()',
    'a directive stays first': '"use strict"\nfoo()\njest.mock("./a")',
    'a directive and a call in parentheses': '"use strict"\nfoo();\n(jest.mock("./a"))',
    'a call with its own semicolon above an array': 'foo()\njest.mock("./x");\n[1, 2].forEach(f)',
    'a call with its own semicolon above a paren': 'foo()\njest.mock("./x");\n(f)()',
  }),
  jsxCase(
    'layout: TSX with _jsxFileName below the imports',
    'import { api } from "./api"\nimport { h } from "./h"\nconst el = <div>{api}</div>\njest.mock("./api")\nuse(el, h)\n',
    'file.tsx',
  ),
  jsxCase(
    'layout: TSX where the last import touches the file name',
    'import { api } from "./api"\njest.mock("./api")\nconst el = <div>{api}</div>\nuse(el)\n',
    'file.tsx',
  ),
  jsxCase(
    'layout: JSX in a factory with an import',
    'import { api } from "./api"\njest.mock("./api", () => () => <div />)\nuse(api)\n',
    'file.jsx',
  ),
  plainCase(
    'layout: a typed file',
    'import type { T } from "./t"\nimport { a } from "./a"\nconst v: T = a as T\njest.mock("./a")\nuse(v)\n',
    'file.ts',
  ),
]

const I = 'import x from "./x"\nfoo(x)\n'

export const VITEST_INPUTS: readonly HoistCase[] = [
  ...group('object', {
    vi: `${I}vi.mock("./x")`,
    vitest: `${I}vitest.mock("./x")`,
    'vitest hoisted': `${I}const h = vitest.hoisted(() => 1)\nuse(h)`,
    'vi imported from vitest': `import { vi } from "vitest"\n${I}vi.mock("./x")`,
    'vitest imported from vitest': `import { vitest } from "vitest"\n${I}vitest.mock("./x")`,
    'vi from vite-plus': `import { vi } from "vite-plus/test"\n${I}vi.mock("./x")`,
    'an alias of vi stays': `import { vi as v } from "vitest"\n${I}v.mock("./x")`,
    'a namespace of vitest stays': `import * as V from "vitest"\n${I}V.vi.mock("./x")`,
    'a local named vi': `const vi = other()\n${I}vi.mock("./x")`,
    'a member named vi': `${I}foo.vi.mock("./x")`,
    'a computed method': `${I}vi["mock"]("./x")`,
    'an optional member is left alone': `${I}vi?.mock("./x")`,
    'an optional call': `${I}vi.mock?.("./x")`,
    'a new': `${I}new vi.mock("./x")`,
    'jest is nothing to Vitest': `${I}jest.mock("./x")`,
    'a comment before the call parens': `${I}vi.mock/* c */("./x")`,
  }),
  ...group('argument', {
    'a string': `${I}vi.mock("./x")`.replace('foo(x)', 'use(x)'),
    'an identifier': `${I}vi.mock(p)`,
    'a template': `${I}vi.mock(\`./x\`)`,
    'a template with an expression': `${I}vi.mock(\`./\${p}\`)`,
    'a factory': `${I}vi.mock("./x", () => ({}))`,
    'a factory reading an import': `import y from "./y"\n${I}vi.mock("./x", () => ({ y }))`,
    'a factory reading a local': `const local = 1\n${I}vi.mock("./x", () => local)`,
    'a factory reading a global': `${I}vi.mock("./x", () => someGlobal)`,
    'a factory with a parameter': `${I}vi.mock("./x", (original) => original)`,
    'a factory naming importActual': `${I}vi.mock("./x", () => vi.importActual("./x"))`,
    'a non-function second argument': `${I}vi.mock("./x", notFn)`,
    'an options object': `${I}vi.mock("./x", { spy: true })`,
    'three arguments': `${I}vi.mock("./x", () => ({}), 3)`,
    'an import argument': `${I}vi.mock(import("./x"))`,
    'an awaited import argument': `${I}vi.mock(await import("./x"))`,
    'an import argument with a factory': `${I}vi.mock(import("./x"), () => ({}))`,
    unmock: `${I}vi.unmock("./x")`,
    'unmock with an import argument': `${I}vi.unmock(import("./x"))`,
    'unmock with two arguments': `${I}vi.unmock("./x", "./y")`,
    'doMock stays': `${I}vi.doMock("./x")`,
    'doMock with an import argument stays': `${I}vi.doMock(import("./x"))`,
    'doUnmock stays': `${I}vi.doUnmock("./x")`,
    'doUnmock with an import argument stays': `${I}vi.doUnmock(import("./x"))`,
    'importActual stays': `${I}vi.importActual("./x")`,
    'doMock then mock': 'vi.doMock("./a")\nvi.mock("./b")',
  }),
  ...group('placement', {
    'a chain is not top level': `${I}vi.mock("./a").mock("./b")`,
    'a result used': `${I}const y = vi.mock("./a")\nuse(y)`,
    'if without a block': `${I}if (z) vi.mock("./a")`,
    'if with a block': `${I}if (z) { vi.mock("./a") }`,
    'a function': 'function g() { return vi.mock("./a") }\ng()',
    'an arrow': 'const f2 = () => vi.mock("./a")\nf2()',
    'a static block': 'class Q { static { vi.mock("./a") } }',
    'a label': `${I}l: vi.mock("./a")`,
    parentheses: `${I}(vi.mock("./a"));`,
    void: `${I}void vi.mock("./a")`,
    await: `${I}await vi.mock("./a")`,
    'a sequence': `${I}vi.mock("./a"), vi.mock("./b")`,
    'a hoisted method on the result': `${I}vi.hoisted(() => 1).then(f)`,
    'a member of a hoisted result': `${I}const z = vi.hoisted(() => 1).y\nuse(z)`,
    'a second declarator': `${I}const a = 1, b = vi.hoisted(() => 1)\nuse(a, b)`,
    'a first declarator with another': `${I}let a = vi.hoisted(() => 1), b = 2\nuse(a, b)`,
    'a hoisted in a function': 'function g() { const h = vi.hoisted(() => 1); return h }\ng()',
  }),
  ...group('guard', {
    'a mock in a guard': `${I}if (import.meta.vitest) { vi.mock("./x") }`,
    'a const hoisted in a guard, used in it': `${I}if (import.meta.vitest) {\n  const h = vi.hoisted(() => 1)\n  use(h)\n}`,
    'a const hoisted in a guard, used after': `${I}if (import.meta.vitest) {\n  const h = vi.hoisted(() => 1)\n}\nuse(typeof h)`,
    'an expression guard': `${I}import.meta.vitest && vi.mock("./a")`,
    'no block': `${I}if (import.meta.vitest) vi.mock("./a")`,
    'nested in a guard': `${I}if (import.meta.vitest) { if (q) { vi.mock("./a") } }`,
    'the else branch': `${I}if (import.meta.vitest) { } else { vi.mock("./a") }`,
    'a different test': `${I}if (import.meta.env) { vi.mock("./a") }`,
    'a call before the guard': `${I}vi.mock("./a")\nif (import.meta.vitest) { vi.mock("./b") }`,
  }),
  ...group('hoisted', {
    'two, the second reading the first':
      'const a = vi.hoisted(() => 1)\nconst b = vi.hoisted(() => a + 1)\nuse(a, b)',
    'two after an import': `${I}const a = vi.hoisted(() => 1)\nconst b = vi.hoisted(() => a + 1)\nuse(a, b)`,
    'a mock factory reads a hoisted': `${I}const a = vi.hoisted(() => ({ v: 1 }))\nvi.mock("./x", () => a)`,
    'a bare hoisted': `${I}vi.hoisted(() => foo())`,
    'an awaited bare hoisted': `${I}await vi.hoisted(async () => foo())`,
    'an awaited const': `${I}const a = await vi.hoisted(async () => 1)\nuse(a)`,
    destructured: `${I}const { a, b } = vi.hoisted(() => ({ a: 1, b: 2 }))\nuse(a, b)`,
    'a hoisted that reads an import': `${I}const a = vi.hoisted(() => x)\nuse(a)`,
    'order with mocks': `${I}vi.mock("./a")\nconst a = vi.hoisted(() => 1)\nvi.mock("./b")\nuse(a)`,
    exported: `export const a = vi.hoisted(() => 1)`,
    'exported default': `export default vi.hoisted(() => 1)`,
    'an exported mock': `export const m = vi.mock("./a")`,
    'a default-exported unmock': `export default vi.unmock("./a")`,
    'a hoisted inside a mock': `vi.mock("./a", () => { vi.hoisted(() => 1) })`,
    'a mock inside a hoisted': `vi.hoisted(() => { vi.mock("./a") })`,
    'a mock inside a mock': `vi.mock("./a", () => { vi.mock("./b") })`,
    'nested and not top level': `function g() { vi.mock("./a", () => { vi.mock("./b") }) }`,
  }),
  ...group('import', {
    'a side-effect import': `import "./s"\nfoo()\nvi.mock("./s")`,
    'an empty named import': `import {} from "./s"\nfoo()\nvi.mock("./s")`,
    'a type-free file with no mock': `import a from "./a"\nuse(a)`,
    'two imports of one module': `import a from "./a"\nimport { b } from "./a"\nuse(a, b)\nvi.mock("./a")`,
    'a stayer between imports': `import a from "./a"\nimport b from "./b"\nconst z = 1\nimport c from "./c"\nvi.mock("./b")\nuse(a, b, c, z)`,
    'an import attribute': `import j from "./j.json" with { type: "json" }\nuse(j)\nvi.mock("./j.json")`,
    'a dynamic import after': `vi.mock("./x")\nfunction f() { return import("./x") }\nf()`,
    'a dynamic specifier': `vi.mock("./x")\nfunction f(p) { return import(p) }\nf("./y")`,
    'a string-named import': `import { "a b" as q } from "./x"\nvi.mock("./x")\nuse(q)`,
  }),
  ...group('binding', {
    shorthand: `import { a } from "./x"\nvi.mock("./x")\nuse({ a })`,
    'class fields': `import { a } from "./x"\nvi.mock("./x")\nclass K { a = a; [a]() {} }\nuse(K)`,
    shadows: `import x from "./x"\nvi.mock("./a", () => x)\nfunction f(x) { return x }\n{ let x = 1; use(x) }\nuse(typeof x, f)`,
    'a switch with a local in a case': `import { x } from "./x"\nvi.mock("./x")\nswitch (x) { case 1: let x = 1; use(x) }`,
    'a test callback': `import { x } from "./x"\nvi.mock("./x")\ntest("t", () => { use(x) })`,
    'a call through an import keeps the namespace': `import { f } from "./x"\nvi.mock("./x")\nf()`,
    'a tagged template': 'import { f } from "./x"\nvi.mock("./x")\nf`y`',
    'a namespace': `import * as n from "./x"\nvi.mock("./x")\nuse(n.y)`,
    'export default of an import': `import { a } from "./x"\nvi.mock("./x")\nexport default a`,
    'an exported function reads the binding': `import { a } from "./x"\nvi.mock("./x")\nexport function f() { return a }`,
  }),
  ...group('re-export', {
    'a named re-export stays static': 'export { x as y } from "./x"\nvi.mock("./x")',
    'a star stays static': 'export * from "./x"\nvi.mock("./x")',
    'a star as stays static': 'export * as n from "./x"\nvi.mock("./x")',
    'a default re-export': 'export { default } from "./x"\nvi.mock("./x")',
    'between imports':
      'import a from "./a"\nexport { b } from "./b"\nimport c from "./c"\nuse(a, c)\nvi.mock("./b")',
  }),
  ...group('layout', {
    'a call already first': 'vi.mock("./a")\nimport a from "./a"\nuse(a)',
    'a leading semicolon and an array': 'const a = 1\nvi.mock("./x")\n;[1, 2].forEach(f)\nuse(a)',
    'a leading semicolon and a paren': 'const a = 1\nvi.mock("./x")\n;(f)()\nuse(a)',
    'the statement touching the anchor':
      'import a from "./a"\nconst z = 1;vi.mock("./a")\nuse(a, z)',
    'a call then a stayer with no newline': 'vi.mock("./a");foo();vi.mock("./b")',
    'CRLF line endings': 'import a from "./a"\r\nfoo()\r\nvi.mock("./a")\r\nuse(a)\r\n',
    'a hashbang': '#!/usr/bin/env node\nimport a from "./a"\nvi.mock("./a")\nuse(a)',
  }),
  jsxCase(
    'layout: TSX with _jsxFileName below the imports',
    'import { api } from "./api"\nimport { h } from "./h"\nconst el = <div>{api}</div>\nvi.mock("./api")\nuse(el, h)\n',
    'file.tsx',
  ),
]
