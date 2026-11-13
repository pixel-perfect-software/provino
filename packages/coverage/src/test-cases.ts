// The constructs the instrumenter is checked on, against `babel-plugin-istanbul` 8.0.0 and
// `istanbul-lib-instrument` 6.0.3 (Jest 30.5.2's own): plain JavaScript, each a module or a script.

export const CASES: readonly { readonly name: string; readonly code: string }[] = [
  {
    name: 'statements and a function',
    code: `export function add(a, b) {\n  const total = a + b;\n  return total;\n}\n`,
  },
  {
    name: 'default parameters',
    code: `export function f(a = 1, { b = 2, c } = {}, [d = 3] = []) {\n  return a + b + d;\n}\nexport const g = (x = compute()) => x;\nfunction compute() { return 1 }\n`,
  },
  {
    name: 'nullish coalescing',
    code: `export const v = (a, b) => a ?? b ?? 'fallback';\nexport function w(o) {\n  return o.x ?? (o.y ?? 0);\n}\n`,
  },
  {
    name: 'optional chaining',
    code: `export const get = (o) => o?.a?.b?.[0]?.(1);\nexport function h(o) {\n  const r = o?.p;\n  return r;\n}\n`,
  },
  {
    name: 'logical assignment',
    code: `let a = null, b = 0, c = 1;\na ??= 5;\nb ||= 7;\nc &&= 9;\nexport { a, b, c };\n`,
  },
  {
    name: 'class fields, methods and static blocks',
    code: `export class A {\n  x = 1;\n  static y = 2;\n  #p = 3;\n  static { A.z = 4; }\n  constructor() { this.q = this.x; }\n  get g() { return this.#p; }\n  set g(v) { this.#p = v; }\n  static s() { return A.y; }\n  m() { return 1; }\n}\n`,
  },
  {
    name: 'getters and setters in object literals',
    code: `export const o = {\n  get a() { return 1; },\n  set a(v) {},\n  b() { return 2; },\n  c: () => 3,\n  async d() { return 4; },\n  *e() { yield 5; },\n};\n`,
  },
  {
    name: 'labelled break and continue',
    code: `export function f(n) {\n  let s = 0;\n  outer: for (let i = 0; i < n; i++) {\n    for (let j = 0; j < n; j++) {\n      if (j > i) continue outer;\n      if (i > 5) break outer;\n      s += j;\n    }\n  }\n  return s;\n}\n`,
  },
  {
    name: 'switch',
    code: `export function f(x) {\n  switch (x) {\n    case 1:\n      return 'a';\n    case 2:\n    case 3:\n      return 'b';\n    default:\n      return 'c';\n  }\n}\n`,
  },
  {
    name: 'ternaries',
    code: `export const t = (a, b) => (a ? (b ? 1 : 2) : b ? 3 : 4);\nexport function u(a) {\n  return a > 1 ? 'big' : 'small';\n}\n`,
  },
  {
    name: 'if, else if, else and loops',
    code: `export function f(a) {\n  if (a > 2) {\n    return 1;\n  } else if (a > 1) {\n    return 2;\n  } else {\n    return 3;\n  }\n}\nexport function g(a) {\n  if (a) return 1;\n  while (a < 10) a++;\n  do { a--; } while (a > 5);\n  for (const k in { x: 1 }) a += k.length;\n  for (const k of [1]) a += k;\n  return a;\n}\n`,
  },
  {
    name: 'logical expressions and short circuits',
    code: `export const l = (a, b, c) => (a && b) || c;\nexport function m(a, b) {\n  return a || b && a;\n}\n`,
  },
  {
    name: 'try, catch and finally',
    code: `export function f(g) {\n  try {\n    return g();\n  } catch (e) {\n    return e;\n  } finally {\n    g.done = true;\n  }\n}\n`,
  },
  {
    name: 'async, generators and arrows with expression bodies',
    code: `export const a = async (x) => await x;\nexport async function* gen() {\n  yield 1;\n  yield* [2, 3];\n}\nexport const b = () => ({ k: 1 });\n`,
  },
  {
    name: 'istanbul ignore next',
    code: `export function f(a) {\n  /* istanbul ignore next */\n  if (a) { return 1; }\n  /* istanbul ignore next */\n  function hidden() { return 2; }\n  return hidden();\n}\n`,
  },
  {
    name: 'istanbul ignore if and else',
    code: `export function f(a, b) {\n  /* istanbul ignore if */\n  if (a) { return 1; }\n  /* istanbul ignore else */\n  if (b) { return 2; } else { return 3; }\n}\n`,
  },
  {
    name: 'istanbul ignore file',
    code: `/* istanbul ignore file */\nexport function f(a) {\n  if (a) { return 1; }\n  return 2;\n}\n`,
  },
  {
    name: 'a hashbang, directives and code on the first line',
    code: `#!/usr/bin/env node\n'use strict';\nexport const x = 1; export function f() { return x; }\n`,
  },
  {
    name: 'CommonJS',
    code: `const fs = require('node:fs');\nmodule.exports = function read(p) {\n  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;\n};\n`,
  },
  {
    name: 'a variable declaration list and a comma expression',
    code: `export let a = 1, b = a + 1, c;\nexport function f() {\n  let x = (a, b);\n  var y, z = 3;\n  return x + z;\n}\n`,
  },
  {
    name: 'exports and default exports',
    code: `export default function () { return 1; }\nexport const arrow = () => 2;\nexport { a as b };\nconst a = 3;\n`,
  },
  {
    name: 'template literals, tagged templates and spread',
    code: `const tag = (s, ...v) => s.raw.join('') + v.length;\nexport const out = tag\`a\${1}b\${2}\`;\nexport const sp = (...xs) => [...xs, ...[1, 2]];\nexport const ob = (o) => ({ ...o, k: 1 });\n`,
  },
  {
    name: 'a long file with nested functions and callbacks',
    code: `export function outer(items) {\n  return items\n    .filter((i) => i > 0)\n    .map((i) => {\n      if (i % 2) {\n        return i * 2;\n      }\n      return (function inner(n) { return n + 1; })(i);\n    })\n    .reduce((acc, i) => acc + i, 0);\n}\n`,
  },
  {
    name: 'an empty file and a comment-only file',
    code: `// nothing here\n`,
  },
]
