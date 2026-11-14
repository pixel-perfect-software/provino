// D116: the in-place TypeScript strip. Each case gives the exact blanked text (so every kept token's
// offset is visible), and the program it makes is checked against Oxc's TypeScript transform, the
// pipeline's path before D116: both printed by Oxc's JavaScript printer, comments dropped. The
// corpora (10,000 fuzz files and excalidraw) are `bench/blank-corpus.test.ts`.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseSync } from 'oxc-parser'
import { transformSync } from 'oxc-transform'
import { type BlankOptions, blankTypeScript } from './blank.ts'

const ELIDE: BlankOptions = {
  onlyRemoveTypeImports: false,
  legacyDecorators: false,
  defineClassFields: true,
  sourceType: 'module',
}
const VERBATIM: BlankOptions = { ...ELIDE, onlyRemoveTypeImports: true }

function blanked(source: string, options: BlankOptions = ELIDE): string {
  const result = blankTypeScript('/f.ts', source, options)
  assert.ok(result.ok, result.ok ? '' : result.reason)
  return result.code
}

/** Oxc's printing of JavaScript, without comments and the `export {}` Oxc adds. */
function printed(code: string): string {
  const options = { lang: 'js', sourceType: 'module', target: 'esnext' } as const
  const first = transformSync('/f.js', code, options)
  assert.deepEqual(first.errors, [])
  let text = first.code
  for (const comment of parseSync('/f.js', text, options).comments.toReversed()) {
    text =
      text.slice(0, comment.start) +
      ' '.repeat(comment.end - comment.start) +
      text.slice(comment.end)
  }
  return transformSync('/f.js', text, options)
    .code.replace(/^export \{\};\n/gm, '')
    .replace(/^import \{\} from ("[^"\n]*");$/gm, 'import $1;')
}

/** The blanked text is the program Oxc's transform makes, and every kept character is in place. */
function assertSameProgram(source: string, code: string, options: BlankOptions): void {
  const oxc = transformSync('/f.ts', source, {
    lang: 'ts',
    sourceType: 'module',
    target: 'esnext',
    typescript: { onlyRemoveTypeImports: options.onlyRemoveTypeImports },
  })
  assert.deepEqual(oxc.errors, [])
  assert.equal(printed(code), printed(oxc.code))
  assert.equal(code.length, source.length)
  for (let at = 0; at < source.length; at++) {
    const kept = code[at]
    if (kept === source[at]) continue
    assert.ok(
      source[at] !== '\n' && (kept === ' ' || kept === ';' || kept === ')'),
      `offset ${at}: ${JSON.stringify(source[at])} became ${JSON.stringify(kept)}`,
    )
  }
}

/** [name, TypeScript, blanked JavaScript] */
const CASES: readonly (readonly [string, string, string])[] = [
  [
    'annotations on variables, parameters, returns and catch',
    'let a: number = 1\nfunction f(b: string, c?: T): void {}\ntry {} catch (e: unknown) {}',
    'let a         = 1\nfunction f(b        , c    )       {}\ntry {} catch (e         ) {}',
  ],
  [
    'generics on calls, new, tagged templates and instantiation expressions',
    'f<T>(x); new Map<string, number>(); tag<T>`x`; const g = h<T>',
    'f   (x); new Map                (); tag   `x`; const g = h   ',
  ],
  [
    'generics on declarations',
    'function f<T extends object = {}>(x: T) {}\nclass C<T> {}\nconst a = <T,>(x: T) => x',
    'function f                       (x   ) {}\nclass C    {}\nconst a =     (x   ) => x',
  ],
  [
    '`as`, `satisfies` (past a parenthesis) and `!`',
    'const a = b as T\nconst c = (d) satisfies U\nconst e = f!.g!',
    'const a = b     \nconst c = (d)            \nconst e = f .g ',
  ],
  ['a `<T>` type assertion', 'const a = <T>b', 'const a =    b'],
  [
    '`interface` and `type`, exported or not',
    'interface I { a: 1 }\ntype T = string\nexport type U = 1\nexport interface J {}\nx()',
    '                    \n               \n                 \n                     \nx()',
  ],
  [
    'every `declare`',
    'declare const a: number\ndeclare function f(): void\ndeclare class C {}\ndeclare module "m" {}\ndeclare global {}\ndeclare enum E {}\ndeclare namespace N {}\nx()',
    '                       \n                          \n                  \n                     \n                 \n                 \n                      \nx()',
  ],
  [
    '`implements`, and type arguments of `extends`',
    'class C extends B<T> implements I, J {}',
    'class C extends B                    {}',
  ],
  [
    'overloads of functions and methods',
    'function f(a: string): void\nfunction f(a: unknown) {}\nclass C {\n  m(): void\n  m() {}\n}',
    '                           \nfunction f(a         ) {}\nclass C {\n           \n  m() {}\n}',
  ],
  [
    '`abstract` classes and members',
    'abstract class A {\n  abstract m(): void\n  abstract p: number\n  q = 1\n}',
    '         class A {\n                    \n                    \n  q = 1\n}',
  ],
  [
    'access modifiers, `readonly` and `override` (`static` stays)',
    'class C {\n  private a = 1\n  protected static b = 2\n  public readonly c = 3\n  override d() {}\n}',
    'class C {\n          a = 1\n            static b = 2\n                  c = 3\n           d() {}\n}',
  ],
  [
    'a `this` parameter, with its comma',
    'function f(this: Window, a: number) {}\nfunction g(this: Window) {}',
    'function f(              a        ) {}\nfunction g(            ) {}',
  ],
  [
    'optional `?` on fields, methods and parameters',
    'class C {\n  a?: number\n  m?() {}\n}\nfunction f(a?: number) {}',
    'class C {\n  a         \n  m () {}\n}\nfunction f(a         ) {}',
  ],
  [
    'definite `!` on variables and fields',
    'let a!: number\nclass C {\n  b!: string\n}',
    'let a         \nclass C {\n  b         \n}',
  ],
  [
    'type-only imports, and imports used only as types, go',
    "import type { A } from 'a'\nimport { type B, c } from 'b'\nimport { D } from 'd'\nimport E, { F } from 'e'\nlet x: D = c(F)",
    "                          \nimport {         c } from 'b'\n                     \nimport    { F } from 'e'\nlet x    = c(F)",
  ],
  [
    'an unused import goes; a side-effect import stays',
    "import { A } from 'a'\nimport * as N from 'n'\nimport 'side'\nx()",
    "                     \n                      \nimport 'side'\nx()",
  ],
  [
    'a parameter that shadows an import is no use of it',
    "import { A } from 'a'\nfunction f(A) { return A }",
    '                     \nfunction f(A) { return A }',
  ],
  [
    'an assignment, a decorator and an export are uses; a `declare` field is not',
    "import { A } from 'a'\nimport { B } from 'b'\nimport { C } from 'c'\nimport { D } from 'd'\nA = 1\n@B class K { declare [D]: number }\nexport { C }",
    "import { A } from 'a'\nimport { B } from 'b'\nimport { C } from 'c'\n                     \nA = 1\n@B class K {                     }\nexport { C }",
  ],
  [
    'type-only exports, and `export { I }` of a type',
    "export type { A } from 'a'\nexport { type B, c } from 'b'\ninterface I {}\nconst v = 1\nexport { I, v }\nexport type * from 'z'",
    "                          \nexport {         c } from 'b'\n              \nconst v = 1\nexport {    v }\n                      ",
  ],
  [
    '`export default` of a type',
    'interface I {}\nexport default I',
    '              \n                ',
  ],
  [
    'ASI: a removed statement before a `(` gets a `;`',
    'let x = 1\ninterface I {}\n(x)',
    'let x = 1\n;             \n(x)',
  ],
  [
    'ASI: a blanked tail before a `[` gets a `;` in it',
    'let x: T\n[1].map(f)',
    'let x;  \n[1].map(f)',
  ],
  [
    'ASI: a template after a removed `declare`',
    'x = a\ndeclare const q: number\n`t`',
    'x = a\n;                      \n`t`',
  ],
  [
    'ASI: a removed class member before a computed key',
    'class C {\n  x = 1\n  declare y: number\n  [k] = 2\n}',
    'class C {\n  x = 1\n  ;                \n  [k] = 2\n}',
  ],
  [
    'ASI: a blanked modifier before a computed key',
    'class C {\n  x = 1\n  private [k] = 2\n}',
    'class C {\n  x = 1\n  ;       [k] = 2\n}',
  ],
  [
    'ASI: a removed member before a generator method',
    'class C {\n  x = 1\n  declare y: number\n  *g() {}\n}',
    'class C {\n  x = 1\n  ;                \n  *g() {}\n}',
  ],
  ['ASI: no hazard, so no `;`', 'let x = 1\ninterface I {}\ny()', 'let x = 1\n              \ny()'],
  [
    'an arrow function’s return type over lines moves its `)` before `=>`',
    'const f = (a):\n  T => a',
    'const f = (a  \n  ) => a',
  ],
  [
    'an arrow function’s return type on one line',
    'const f = (a: number): number => a',
    'const f = (a        )         => a',
  ],
]

describe('blankTypeScript: the text, and the program Oxc makes', () => {
  for (const [name, source, expected] of CASES) {
    test(name, () => {
      const code = blanked(source)
      assert.equal(code, expected)
      assertSameProgram(source, code, ELIDE)
    })
  }
})

// A removed or blanked statement after a compound statement: the `;` rule follows `if`/`else`,
// loops, labels and `with` to the statement they end with (review of 7b19fdf, finding 8). Each line
// before the fix joined the next onto the body: `if (c) x = a(y)`.
const COMPOUND_TAIL_CASES: readonly string[] = [
  'let x, a, c\nif (c) x = a\ntype T = 1\n(y)',
  'let x, a, c\nif (c) x = 1\nelse x = a\ninterface I {}\n(y)',
  'let x, a, c\nif (c) x = a as T\n(y)',
  'let x, a, c\nif (c) x = a\ntype T = 1\n[1].map(f)',
  'let x, a, c\nif (c) x = a\ndeclare const q: number\n`t`',
  'let x, a, c\nwhile (c) x = a\ntype T = 1\n(y)',
  'let x, a, c\nfor (;;) x = a\ntype T = 1\n(y)',
  'let x, a, c\nfor (const k of c) x = a\ntype T = 1\n(y)',
  'let x, a, c\nfor (const k in c) x = a\ntype T = 1\n(y)',
  'let x, a\nl: x = a\ntype T = 1\n(y)',
  'let x, a, c, d\nif (c) if (d) x = 1; else x = a\ntype T = 1\n(y)',
  'let x, a, c\nif (c) l: while (c) x = a\ntype T = 1\n(y)',
  'function f() {\n  if (c) return a\n  type T = 1\n  (y)\n}',
]

describe('ASI after a compound statement: the `;` goes where its tail needs one', () => {
  for (const source of COMPOUND_TAIL_CASES) {
    test(JSON.stringify(source), () => {
      assertSameProgram(source, blanked(source), ELIDE)
    })
  }

  test('`with` (sloppy CommonJS)', () => {
    const source = 'var x, a, o\nwith (o) x = a\ntype T = 1\n(y)'
    const options: BlankOptions = { ...ELIDE, sourceType: 'commonjs' }
    const result = blankTypeScript('/f.ts', source, options)
    assert.ok(result.ok, result.ok ? '' : result.reason)
    assert.match(result.code, /x = a\n;/)
  })
})

describe('more shapes Oxc reads one way and a naive strip another', () => {
  const cases: readonly string[] = [
    // Finding 11: an enum initializer is a use of an import, a `declare` enum's too.
    "import { a } from './a'\ndeclare enum E { X = a }",
    "import { a } from './a'\nexport declare enum E { X = a }",
    // Finding 12: an optional binding pattern's `?` goes.
    'function f([a]?) { return a }',
    'const g = ({ a }?: { a: number }) => a',
    'function h([a = 1]?: number[], { b }?) {}',
    // A type assertion with no line break after it stays on the strip.
    'function k() { return <number>/* c */ 42 }',
  ]
  for (const source of cases) {
    test(JSON.stringify(source), () => {
      assertSameProgram(source, blanked(source), ELIDE)
    })
  }
})

describe('under `verbatimModuleSyntax`, only `type` imports go (Oxc’s `onlyRemoveTypeImports`)', () => {
  const cases: readonly (readonly [string, string])[] = [
    ["import { A } from 'a'\nlet x: A", "import { A } from 'a'\nlet x   "],
    ["import { type A } from 'a'", "import {        } from 'a'"],
    ["import D, { type A } from 'a'", "import D             from 'a'"],
    ["import type { A } from 'a'\nx()", '                          \nx()'],
  ]
  for (const [source, expected] of cases) {
    test(JSON.stringify(source), () => {
      const code = blanked(source, VERBATIM)
      assert.equal(code, expected)
      assertSameProgram(source, code, VERBATIM)
    })
  }
})

describe('syntax with runtime meaning falls back to Oxc’s transform, with the reason', () => {
  const cases: readonly (readonly [string, string, Partial<BlankOptions>?])[] = [
    ['enum E { A }', 'an enum'],
    ['const enum E { A }', 'an enum'],
    ['namespace N { export const x = 1 }', 'a namespace with values'],
    ['module N { export function f() {} }', 'a namespace with values'],
    ['class A { constructor(private x: number) {} }', 'a parameter property'],
    ["import x = require('x')", '`import x =`'],
    ['import X = N.Y', '`import x =`'],
    ['export = 1', '`export =`'],
    ['@dec class A {}', 'a decorator under `experimentalDecorators`', { legacyDecorators: true }],
    ['class A { x = 1 }', 'useDefineForClassFields: false', { defineClassFields: false }],
    ['function f() {\n  return <\n    T>b\n}', 'a type assertion spans lines'],
    // Finding 10: a break after the `>` is one after `return`, `throw` or `yield`.
    ['function f() {\n  return <number>\n    42\n}', 'a type assertion spans lines'],
    ['function f(e) {\n  throw <Error>\n    e\n}', 'a type assertion spans lines'],
    ['function* f() {\n  yield <number>\n    1\n}', 'a type assertion spans lines'],
    ['function f() {\n  return <number>/*\n*/ 42\n}', 'a type assertion spans lines'],
    // Finding 9: a decorated `declare` field is still decorated under legacy decorators.
    [
      'class A { @Attr() declare x: string }',
      'a decorator under `experimentalDecorators`',
      { legacyDecorators: true },
    ],
    [
      'class A { @Attr() abstract x: string }',
      'a decorator under `experimentalDecorators`',
      { legacyDecorators: true },
    ],
    ['const f = async <\n  T,\n>(a: T) => a', 'async arrow function span lines'],
    ['const = ;', 'parse errors'],
  ]
  for (const [source, reason, extra] of cases) {
    test(`${JSON.stringify(source)}: ${reason}`, () => {
      const result = blankTypeScript('/f.ts', source, { ...ELIDE, ...extra })
      assert.equal(result.ok, false)
      assert.ok(!result.ok && result.reason.includes(reason), result.ok ? '' : result.reason)
    })
  }

  test('a namespace that holds only types is erasable', () => {
    const source = 'namespace N { export type T = 1; export interface I {} }\nx()'
    assertSameProgram(source, blanked(source), ELIDE)
  })
})
