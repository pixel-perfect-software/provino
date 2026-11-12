// The scoping corpus of B20 (T3.13): hand-written cases in groups, and a seeded generator of
// programs that mix imports with every construct that can shadow them. Test-only.

export interface Case {
  readonly id: string
  readonly source: string
}

const IMPORTS = "import def, { a, b as c } from 'm1'\nimport * as ns from 'm2'\n"

/** Hand-written cases by group; each `source` is a whole module. */
export const SCOPING_GROUPS: Readonly<Record<string, readonly string[]>> = {
  'shadow-parameter': [
    'function f(a) { return a }\nexport const r = f(1) + a',
    'const f = (a) => a\nexport const r = [f(1), a]',
    'const f = a => a\nexport const r = [f(1), a]',
    'const f = async a => a\nexport const r = [typeof f(1), a]',
    'const o = { m(a) { return a }, get g() { return a }, set s(a) { this.v = a } }\nexport const r = [o.m(1), o.g]',
    'class K { m(a) { return a } static s(a) { return a } constructor(a) { this.v = a } }\nexport const r = [new K(2).v, K.s(3), a]',
    'function f({ a }) { return a }\nexport const r = [f({ a: 1 }), a]',
    'function f([a]) { return a }\nexport const r = [f([1]), a]',
    'function f(...a) { return a }\nexport const r = [f(1), a]',
    'function f(a = 5) { return a }\nexport const r = [f(), a]',
    'function f(x = a) { return x }\nexport const r = f()',
    'function f(x = a, a = 2) { return x }\nexport const r = (() => { try { return f() } catch (e) { return e.name } })()',
    'function f(a) { var a; return a }\nexport const r = [f(1), a]',
    'function f(x = a) { var a = 2; return [x, a] }\nexport const r = f()',
    'function* g(a) { yield a }\nexport const r = [[...g(1)], a]',
    'const f = function a() { return typeof a }\nexport const r = [f(), a]',
  ],
  'shadow-var': [
    'function f() { var a = 1; return a }\nexport const r = [f(), a]',
    'function f() { if (true) { var a = 1 } return a }\nexport const r = [f(), a]',
    'function f() { return a; var a = 1 }\nexport const r = f()',
    'function f() { for (var a = 0; a < 1; a++); return a }\nexport const r = [f(), a]',
    'function f() { for (var a of [1]); return a }\nexport const r = [f(), a]',
    'function f() { for (var a in { k: 1 }); return a }\nexport const r = [f(), a]',
    'function f() { try { throw 1 } catch { var a = 3 } return a }\nexport const r = [f(), a]',
    'function f() { switch (1) { case 1: var a = 4 } return a }\nexport const r = [f(), a]',
    'function f() { { var a = 5 } return a }\nexport const r = [f(), a]',
    'function f() { l: { var a = 6; break l } return a }\nexport const r = [f(), a]',
    'const f = () => { var a = 7; return a }\nexport const r = [f(), a]',
    'class K { static { var a = 8; K.v = a } }\nexport const r = [K.v, a]',
    'var { a: q } = { a: 1 }\nexport const r = [q, a]',
  ],
  'shadow-lexical': [
    '{ let a = 1; var seen = a }\nexport const r = [seen, a]',
    '{ const a = 1; var seen = a }\nexport const r = [seen, a]',
    'function f() { let a = 1; return a }\nexport const r = [f(), a]',
    'function f() { const a = 1; { const a = 2; var inner = a } return [a, inner] }\nexport const r = [f(), a]',
    'function f() { { a } ; let a = 1 }\nexport const r = (() => { try { return f() } catch (e) { return e.name } })()',
    '{ class a {} var seen = typeof a }\nexport const r = [seen, a]',
    '{ function a() { return 1 } var seen = a() }\nexport const r = [seen, a]',
    'if (true) { function a() {} }\nexport const r = a',
    'export const r = (() => { { let a = 1 } return a })()',
    'export const r = (() => { let x = a; { let a = 2 } return x })()',
  ],
  'shadow-names': [
    'class a {}\nexport const r = 1',
    'export const r = (() => { class a { static n = 1 } return a.n })()',
    'export const r = (() => { function a() { return 2 } return a() })()',
    'export const r = (() => { const K = class a { static v = typeof a }; return K.v })()',
    'export const r = (() => { const f = function a() { return typeof a }; return f() })()',
    'export const r = (() => { class K extends a {} return typeof K })()',
    'export const r = (() => { class K { [a]() {} } return Object.getOwnPropertyNames(K.prototype) })()',
    'export const r = (() => { class K { a = a } return typeof new K().a })()',
    'export const r = (() => { class K { static a = a } return typeof K.a })()',
    'export const r = (() => { class K { #p = a; get p() { return this.#p } } return typeof new K().p })()',
  ],
  'shadow-catch': [
    'export const r = (() => { try { throw 1 } catch (a) { return a } })()',
    'export const r = (() => { try { throw { a: 1 } } catch ({ a }) { return a } })()',
    'export const r = (() => { try { throw [1] } catch ([a]) { return a } })()',
    'export const r = (() => { try { throw 1 } catch { return a } })()',
    'export const r = (() => { try { throw 1 } catch (e) { var a = 2 } return a })()',
    'export const r = (() => { try { throw 1 } catch (e) { return a } })()',
    'export const r = (() => { try { throw 1 } catch ({ x = a }) { return typeof x } })()',
  ],
  'shadow-for': [
    'export const r = (() => { for (let a = 0; a < 1; a++) { return a } })()',
    'export const r = (() => { for (const a of [1]) { return a } })()',
    'export const r = (() => { for (const a in { k: 1 }) { return a } })()',
    'export const r = (() => { for (let i = 0, j = a; i < 1; i++) return j })()',
    'export const r = (() => { for (let i = a; i < 2; i++) { let a = 1 } return typeof a })()',
    'export const r = (() => { const out = []; for (let a = 0; a < 2; a++) out.push(() => a); return out.map((f) => f()) })()',
    'export const r = (() => { for (const [a] of [[1]]) return a })()',
    'export const r = (() => { for (const { a } of [{ a: 1 }]) return a })()',
    'export const r = (() => { let a2; for (a2 of [1]) ; return [a2, a] })()',
    'export const r = (() => { for (a of []); })()',
    'export const r = (() => { for (a in {}); })()',
    'export const r = (() => { while (false) { a } return a })()',
    'export const r = (() => { do { a } while (false); return a })()',
  ],
  'shadow-switch': [
    'export const r = (() => { switch (a) { case 1: let a = 2; return a } })()',
    'export const r = (() => { switch (1) { case 1: let a = 2; return a } })()',
    'export const r = (() => { switch (1) { case 1: { let a = 2 } return a } })()',
    'export const r = (() => { switch (1) { case a: return 1; case 2: let a } })()',
    'export const r = (() => { switch (1) { case 1: function a() { return 3 } return a() } })()',
    'export const r = (() => { switch (1) { default: const a = 4; return a } })()',
    'export const r = (() => { switch (typeof a) { case "undefined": return 1; default: return a } })()',
  ],
  destructuring: [
    'export const { x, y = a } = { x: 1 }',
    'export const [p, q = a] = [1]',
    'const { [a]: v1 } = { k: 1 }\nexport const r = v1',
    'const { a: renamed = c } = {}\nexport const r = renamed',
    'const { ...rest } = ns\nexport const r = Object.keys(rest).length',
    'export const r = (() => { let x, y; ({ x = a } = {}); [y = c] = []; return [x, y] })()',
    'export const r = (() => { let x; ({ k: x } = { k: a }); return x })()',
    'export const r = (() => { const f = ({ x = a }) => x; return f({}) })()',
    'export const r = (() => { const f = ([x = a]) => x; return f([]) })()',
    'export const r = (() => { const f = (x = {}) => ({ ...x, a }); return f() })()',
    'var { a: va } = { a: 1 }\nexport const r = [va, c]',
    'export const r = (() => { let a2 = { v: 1 }; ({ v: a2.v } = { v: 2 }); return a2.v })()',
    'export const r = (() => { [a.x] = [1]; return 1 })()',
    'export const r = (() => { ({ v: a.x } = { v: 1 }); return 1 })()',
  ],
  'shorthand-vs-pattern': [
    'export const r = { a }',
    'export const r = { a, c, def }',
    'export const r = { a, ns }',
    'export const r = { a: 1, c }',
    'export const r = { [a]: 1 }',
    'export const r = { a() { return 1 } }',
    'export const r = { get a() { return 1 }, set a(v) {} }',
    'export const r = { async a() {}, *b() {} }',
    'export const r = (() => { const a = 1; return { a } })()',
    'export const r = (() => { const f = (a) => ({ a }); return f(2) })()',
    'export const r = (() => { const { a } = { a: 5 }; return a })()',
    'export const r = (() => { const o = { a, ...{ a } }; return Object.keys(o) })()',
    'export const r = ({ a }).a',
    'export const r = ({ a, }).a',
    'export const r = [{ a }, { c }]',
    'export const r = { f: () => ({ a }) }',
  ],
  'callee-forms': [
    'export const r = a()',
    'export const r = c()',
    'export const r = def()',
    'export const r = ns.a()',
    'export const r = a.b()',
    'export const r = new a()',
    'export const r = new a.b()',
    'export const r = new a(1)',
    'export const r = a`t`',
    'export const r = a.b`t`',
    'export const r = a?.()',
    'export const r = a?.b()',
    'export const r = a?.b?.()',
    'export const r = (a)()',
    'export const r = (a.b)()',
    'export const r = (a?.b)()',
    'export const r = (0, a)()',
    'export const r = [a][0]()',
    'export const r = a()()',
    'export const r = a(a)',
    'export const r = typeof a',
    'export const r = void a',
    'export const r = a ? a : a',
    'export const r = a + a * a',
    'export const r = a ?? c',
    'export const r = await a()',
    'foo()\n;a()\nexport const r = 1',
    'let z = 1\n;a()\n;(a)()\nexport const r = z',
    'if (true) a()\nelse c()\nexport const r = 1',
    'for (const k of []) a()\nexport const r = 1',
    'l: a()\nexport const r = 1',
    'function f() { a()\n;[1].map(c)\n}\nexport const r = 1',
    'const x = 1\n;(a)\nexport const r = x',
    'export const r = (() => { return a() })()',
    'export const r = (() => { return a\n() })()',
  ],
  'assignment-and-update': [
    'export const r = (() => { a = 1 })()',
    'export const r = (() => { a += 1 })()',
    'export const r = (() => { a++ })()',
    'export const r = (() => { --a })()',
    'export const r = (() => { a ||= 1 })()',
    'export const r = (() => { a.b = 1 })()',
    'export const r = (() => { a[0] = 1 })()',
    'export const r = (() => { delete a.b })()',
    'export const r = (() => { delete a })()',
    'export const r = (() => { [a] = [1] })()',
    'export const r = (() => { ({ a } = {}) })()',
    'export const r = (() => { ({ x: a } = {}) })()',
    'export const r = (() => { [...a] = [1] })()',
    'export const r = (() => { [x = a] = []; var x })()',
  ],
  'export-forms': [
    'export const x = 1\nexport let y = 2\nexport var z = 3',
    'export const x = 1, y = 2',
    'export const { x, y: [z] } = { x: 1, y: [2] }',
    'export function f() {}\nexport async function g() {}\nexport function* h() {}\nexport async function* i() {}',
    'export class K {}',
    'const x = 1\nexport { x }',
    'const x = 1\nexport { x as y, x as z }',
    'const x = 1\nexport { x as default }',
    'const x = 1\nexport { x as "str name" }',
    'export { a }',
    'export { a as b }',
    'export { c, def }',
    'export { ns }',
    'export { ns as default }',
    'export { default } from "m3"',
    'export { x } from "m3"',
    'export { x as y, z } from "m3"',
    'export { default as d } from "m3"',
    'export { x as "str name" } from "m3"',
    'export { "str in" as y } from "m3"',
    'export * from "m3"',
    'export * as n from "m3"',
    'export * as "s n" from "m3"',
    'export * as default from "m3"',
    'export * from "m3"\nexport * from "m4"',
    'export {}',
    'export {} from "m3"',
    'import "m3"',
    'import {} from "m3"',
    'import d from "m3"\nimport * as n from "m3"\nexport { d, n }',
    'import d, * as n from "m3"\nexport const r = [d, n]',
    'import d, { x } from "m3"\nexport const r = [d, x]',
    'import { default as d, x as xx } from "m3"\nexport const r = [d, xx]',
    'import { "str in" as s } from "m3"\nexport const r = s',
    'import { x, x as y } from "m3"\nexport const r = [x, y]',
    'import x from "m3"\nimport y from "m3"\nexport const r = [x, y]',
    'export const r = a\nexport { r as r2 }',
    'export const f = () => a\nexport const g = () => c',
    'export const o = { a }',
    'export function f(a) { return a }\nexport function g() { return a }',
    'export class K extends a {}',
    'export class K { static m = a }',
  ],
  'default-forms': [
    'export default 1',
    'export default 1 + 1',
    'export default a',
    'export default (a)',
    'export default a()',
    'export default { a }',
    'export default [a, c]',
    'export default () => a',
    'export default async () => a',
    'export default function () {}',
    'export default function () { return a }',
    'export default function f() { return a }\nf()',
    'export default function* () {}',
    'export default async function () {}',
    'export default async function f() {}',
    'export default class {}',
    'export default class { static v = a }',
    'export default class K { static v = a }',
    'export default (function () {})',
    'export default (class {})',
    'export default function () {}\n;[1].map(c)',
    'export default function () {}\n(a)',
    'export default class {}\n;(a)',
    'export default a\nexport const r = 2',
    'export default `t${a}`',
    'export default typeof a',
    'export default await a',
    'const x = 1\nexport default x',
    'export default /* c */ a',
    'export /* c */ default a',
    'export default\na',
  ],
  'string-names': [
    'import { "a-b" as ab } from "m3"\nexport const r = ab',
    'import { "default" as d } from "m3"\nexport const r = d',
    'import { "if" as i } from "m3"\nexport const r = i',
    'import { default as def2, "x y" as xy } from "m3"\nexport { def2 as "d 2", xy as "x y" }',
    'import { "é" as e } from "m3"\nexport const r = e',
    'export { a as "a b" }',
    'export { c as "c-d" } from "m3"',
  ],
  'tdz-and-live': [
    'export const r = (() => { try { return x } catch (e) { return e.name } })()\nconst x = 1',
    'export const r = (() => { return a })()\nexport { r as r2 }',
    'export const r = () => a\nexport const s = r()',
    'export let n = 0\nexport function inc() { n++ }',
    'export { later }\nconst later = 1',
    'export default later\nvar later = 1',
    'export * from "m3"\nexport { a }',
    'export { a }\nexport const t = a',
  ],
  'dynamic-and-meta': [
    'export const r = import("./x.js")',
    'export const r = import("./x.js", { with: { type: "json" } })',
    'export const r = import(a)',
    'export const r = import(`./y.js`)',
    'export const r = import(`./${a}.js`)',
    'export const r = import("./x.js").then((m) => m.default)',
    'export const r = () => import("./x.js")\nexport const s = () => import("./z.js")',
    'export const r = [import("./x.js"), import("./x.js")]',
    'export const r = import.meta',
    'export const r = import.meta.url',
    'export const r = () => import.meta.env',
    'export const r = typeof import.meta',
    'export const r = (() => { function f() { return new.target } return typeof f })()',
    'const ns2 = await import("./x.js")\nexport const r = ns2',
    'export const r = import /* c */ ("./x.js")',
    'export const r = import\n("./x.js")',
  ],
  'directives-and-joins': [
    '"use strict"\nexport const r = a',
    '"use strict";\nexport const r = a',
    "'use strict'\n'use asm'\nexport const r = a",
    '#!/usr/bin/env node\nexport const r = a',
    '#!/usr/bin/env node\n"use strict"\nexport const r = a',
    '#!/usr/bin/env node\n"use strict";\nimport q from "m3"\nexport const r = q',
    '"use strict"\nimport q from "m3"\nexport const r = q',
    '"use strict"\nexport default 1',
    '"use strict"\n;(a)\nexport const r = 1',
    'const x = 1\nimport q from "m3"\n;[x].map(() => q)\nexport const r = 1',
    'const x = 1\nimport q from "m3"\n(q)\nexport const r = 1',
    'const x = q\nexport { x }\n(c)\nimport q from "m3"',
    'const f = () => 1\nexport {}\n;[f].map(c)',
    'const f = () => 1\nexport {}\n[f].map(c)',
    'let t = 1\nexport { t }\n+1',
    'let t = 1\nexport { t }\n`x`',
    'let t = 1\nexport { t }\n/re/.test("x")',
    'let t = 1\nexport { t }\n-1',
    '/* lead */ import q from "m3" // trail\n/* c3 */ export const r = q /* c4 */',
    'import q from "m3"; export const r = q; import w from "m4"; export const s = w',
    'export const x = 1; export const y = 2',
    'await 1\nimport q from "m3"\nexport const r = q',
    'export const r = await 1',
    'import "m3"\nimport "m4"\nimport "m3"',
    '\n\n\nimport q from "m3"\n\n\nexport const r = q\n\n',
    'import q from "m3"',
    '',
    '// only a comment',
    'export const r = a\n// trailing comment',
  ],
  'hoister-output': [
    "const __provino_import_0__ = await __provino_import__('./dep.js')\nexport const r = __provino_import_0__.x",
    "import { a } from 'm1'\nconst __provino_import_0__ = await __provino_import__('./dep.js')\nexport const r = [a, __provino_import_0__]",
    "Object.defineProperty(__vite_ssr_exports__, 'x', { enumerable: true, configurable: true, get() { return __provino_import_0__.x } })\nconst __provino_import_0__ = await __provino_import__('./dep.js')\nexport const r = 1",
    "import { vi } from 'vitest'\nvi.mock('./dep.js')\nconst __provino_import_0__ = await __provino_import__('./dep.js')\nexport const r = [vi, __provino_import_0__]",
    "const __provino_import_0__ = await __provino_import__('./dep.js')\n__vite_ssr_exportAll__(__provino_import_0__)\nexport const r = 1",
    "import { jest } from '@jest/globals'\njest.mock('./dep.js')\nconst __provino_import_0__ = await __provino_import__('./dep.js')\nexport const r = (0, __provino_import_0__.f)()",
  ],
}

export const SCOPING_CASES: readonly Case[] = Object.entries(SCOPING_GROUPS).flatMap(
  ([group, sources]) =>
    sources.map((source, i) => ({
      id: `${group}-${String(i).padStart(2, '0')}`,
      // Most cases use the same imports; a case that writes its own import is run as written.
      source:
        /^\s*(?:#!|["']use|import |\/\*|await )/.test(source) || source === ''
          ? source
          : IMPORTS + source,
    })),
)

/** mulberry32: a small seeded PRNG, so a corpus is the same on every run. */
export function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const IMPORT_NAMES = ['a', 'c', 'def', 'ns'] as const
const OTHER_NAMES = ['x', 'y'] as const
const ALL_NAMES = [...IMPORT_NAMES, ...OTHER_NAMES] as const

/** The share of generated programs that redeclare an import binding on purpose (an error path). */
const REDECLARE_SHARE = 0.05

/** What a scope declares, so a generated name never clashes with another in the same scope. */
interface Scope {
  /** `let`, `const`, `class` and function names (at the top: the imports). */
  readonly lexical: Set<string>
  /** Parameter names: a `let` in the body clashes with one, a `var` does not. */
  readonly params: Set<string>
  /** `var` names hoisted through this scope: a `let` of the same name here would clash. */
  readonly vars: Set<string>
  readonly isFunction: boolean
}

/**
 * Seeded programs: imports of `a`, `c`, `def` and `ns`, then nested scopes that declare, shadow and
 * use those names in every position the generator knows (calls, shorthand, patterns, writes).
 * A program is valid JavaScript, except for the ones that redeclare an import binding on purpose
 * (about `REDECLARE_SHARE`), which both transforms must report alike. The programs are unique:
 * the generator goes on until it has `count` different ones.
 */
export function generateScopingPrograms(count: number, seed: number): Case[] {
  const next = random(seed)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T
  const chance = (p: number): boolean => next() < p

  function use(): string {
    const name = pick(ALL_NAMES)
    switch (Math.floor(next() * 14)) {
      case 0:
        return `${name}()`
      case 1:
        return `${name}.p`
      case 2:
        return `({ ${name} })`
      case 3:
        return `[${name}]`
      case 4:
        return `typeof ${name}`
      case 5:
        return `new ${name}()`
      case 6:
        return `${name}\`t\``
      case 7:
        return `${name}?.()`
      case 8:
        return `(${name}, 1)`
      case 9:
        return `{ ${name} } = {}`
      case 10:
        return `${name} = 1`
      case 11:
        return `\`\${${name}}\``
      case 12:
        return `${name}?.p`
      default:
        return name
    }
  }

  function exprStatement(lead = ';'): string {
    const text = use()
    // A bare object-pattern assignment has to be parenthesised to be a statement.
    return text.startsWith('{') ? `${lead}(${text})` : `${lead}${text}`
  }

  function pattern(): { text: string; names: string[] } {
    const first = pick(ALL_NAMES)
    switch (Math.floor(next() * 6)) {
      case 0:
        return { text: first, names: [first] }
      case 1:
        return { text: `{ ${first} }`, names: [first] }
      case 2:
        return { text: `[${first}]`, names: [first] }
      case 3:
        return { text: `{ k: ${first} = ${pick(ALL_NAMES)} }`, names: [first] }
      case 4:
        return { text: `[${first} = ${pick(ALL_NAMES)}]`, names: [first] }
      default:
        return { text: `...${first}`, names: [first] }
    }
  }

  const scopes: Scope[] = []
  const here = (): Scope => scopes[scopes.length - 1] as Scope

  /** Whether a `let`, `const`, `class` or function of `name` is valid in the current scope. */
  function lexicalFree(name: string): boolean {
    const scope = here()
    return !scope.lexical.has(name) && !scope.params.has(name) && !scope.vars.has(name)
  }

  /** Whether `var name` is valid here: no enclosing scope up to the function declares it. */
  function varFree(name: string): boolean {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const scope = scopes[i] as Scope
      if (scope.lexical.has(name)) return false
      if (scope.isFunction) break
    }
    return true
  }

  /** Records `var name`, which hoists through every scope up to the function's. */
  function declareVar(name: string): void {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const scope = scopes[i] as Scope
      scope.vars.add(name)
      if (scope.isFunction) break
    }
  }

  interface Init {
    readonly lexical?: readonly string[]
    readonly params?: readonly string[]
    readonly vars?: readonly string[]
    readonly isFunction?: boolean
  }

  function block(depth: number, init: Init = {}): string {
    scopes.push({
      lexical: new Set(init.lexical),
      params: new Set(init.params),
      vars: new Set(init.vars),
      isFunction: init.isFunction === true,
    })
    const lines: string[] = []
    const count = 1 + Math.floor(next() * 4)
    for (let i = 0; i < count; i++) lines.push(statement(depth))
    scopes.pop()
    return lines.join('\n')
  }

  function declaration(kind: 'let' | 'const' | 'var'): string {
    const name = pick(ALL_NAMES)
    if (kind === 'var') {
      if (!varFree(name)) return exprStatement()
      declareVar(name)
    } else {
      if (!lexicalFree(name)) return exprStatement()
      here().lexical.add(name)
    }
    return `${kind} ${name} = ${chance(0.5) ? pick(ALL_NAMES) : '1'}`
  }

  function statement(depth: number): string {
    const roll = Math.floor(next() * (depth > 3 ? 4 : 16))
    switch (roll) {
      case 0:
      case 1:
        return exprStatement()
      case 2:
        return declaration('let')
      case 3:
        return `out.push(${use().startsWith('{') ? `(${use()})` : use()})`
      case 4:
        return declaration('const')
      case 5:
        return declaration('var')
      case 6: {
        const params = pattern()
        const name = `${pick(OTHER_NAMES)}${depth}`
        // Two functions of one name in a block are a duplicate declaration in a module.
        if (!lexicalFree(name)) return exprStatement()
        here().lexical.add(name)
        return `function ${name}(${params.text.replace('...', '')}) { ${block(depth + 1, { params: params.names, isFunction: true })} }`
      }
      case 7: {
        const params = pattern()
        return `out.push((${params.text}) => { ${block(depth + 1, { params: params.names, isFunction: true })} })`
      }
      case 8:
        return `{ ${block(depth + 1)} }`
      case 9: {
        const name = pick(ALL_NAMES)
        const tried = block(depth + 1)
        return `try { ${tried} } catch (${chance(0.7) ? name : `{ k: ${name} }`}) { ${block(depth + 1, { lexical: [name] })} }`
      }
      case 10: {
        const name = pick(ALL_NAMES)
        return `for (let ${name} = 0; ${name} < 1; ${name}++) { ${block(depth + 1, { lexical: [name] })} }`
      }
      case 11: {
        const name = pick(ALL_NAMES)
        return `for (const ${name} of [1]) { ${block(depth + 1, { lexical: [name] })} }`
      }
      case 12:
        return `switch (${pick(ALL_NAMES)}) { case ${pick(ALL_NAMES)}: ${block(depth + 1)}\n break; default: ${exprStatement()} }`
      case 13: {
        const name = pick(ALL_NAMES)
        const cls = `K${depth}_${Math.floor(next() * 1e6)}`
        if (!lexicalFree(cls)) return exprStatement()
        here().lexical.add(cls)
        return `class ${cls} extends ${pick(ALL_NAMES)} { static ${chance(0.5) ? 'v' : `[${name}]`} = ${pick(ALL_NAMES)}; m(${name}) { ${block(depth + 1, { params: [name], isFunction: true })} } }`
      }
      case 14:
        return `if (${pick(ALL_NAMES)}) ${exprStatement('')}\nelse ${exprStatement('')}`
      default: {
        const name = pick(OTHER_NAMES)
        const declared = pick(ALL_NAMES)
        return `out.push(function ${name}() { var ${declared}; ${block(depth + 1, { vars: [declared], isFunction: true })} })`
      }
    }
  }

  const cases: Case[] = []
  const seen = new Set<string>()
  // A program is the same program if it has the same text before its per-index export names.
  for (let attempt = 0; cases.length < count; attempt++) {
    if (attempt > count * 20) throw new Error(`the scoping generator found no ${count} programs`)
    const lines = [
      "import def, { a, b as c } from 'm1'",
      "import * as ns from 'm2'",
      'const out = []',
    ]
    // Names `x` and `y` are free (no declaration): the generator treats them as ordinary globals.
    lines.push(block(0, { lexical: ['out', ...IMPORT_NAMES], isFunction: true }))
    if (chance(REDECLARE_SHARE)) {
      const name = pick(IMPORT_NAMES)
      lines.push(
        pick([
          `let ${name} = 1`,
          `const ${name} = 1`,
          `var ${name} = 1`,
          `function ${name}() {}`,
          `class ${name} {}`,
        ]),
      )
    }
    if (chance(0.3)) lines.push(`export const r$I = ${pick(IMPORT_NAMES)}`)
    if (chance(0.2)) lines.push(`export default ${pick(IMPORT_NAMES)}`)
    if (chance(0.2)) lines.push(`export { ${pick(IMPORT_NAMES)} as e$I }`)
    const text = `${lines.join('\n')}\n`
    if (seen.has(text)) continue
    seen.add(text)
    const i = cases.length
    cases.push({
      id: `generated-${String(i).padStart(5, '0')}`,
      source: text.replaceAll('$I', String(i)),
    })
  }
  return cases
}
