// What a move leaves behind in raw JavaScript: a statement must not join up with the one before it
// once the statement between them is gone. TypeScript and TSX come out of Oxc with semicolons, so
// this is about plain `.js`. Where the output can run without imports, it runs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Node } from './ast.ts'
import { parseForHoist } from './parse.ts'
import { hoist } from './test-helpers.ts'
import { blockPolicy, topLevelPolicy } from './test-policies.ts'

/** Runs hoisted code with `jest`, `vi`, `use` and `f` as recorders, and returns what they saw. */
function run(code: string): string[] {
  const seen: string[] = []
  const object = {
    mock: (path: string) => {
      seen.push(`mock ${path}`)
    },
    hoisted: (factory: () => unknown) => factory(),
  }
  const use = (): number => {
    seen.push('use')
    return 1
  }
  const f = (value: unknown): void => {
    seen.push(`f ${String(value)}`)
  }
  const fn = new Function('jest', 'vi', 'use', 'f', code)
  fn(object, object, use, f)
  return seen
}

/** The source text of each top-level statement. */
function statements(code: string): string[] {
  const parsed = parseForHoist('case.js', code)
  assert.ok(parsed.ok, `the output parses:\n${code}`)
  return parsed.program.body.map((node: Node) =>
    code.slice(node.start, node.end).replace(/[\s;]+$/, ''),
  )
}

const RUNNABLE: readonly (readonly [string, string, readonly string[]])[] = [
  [
    'a `;` on the next line moves with its statement, and `[` still gets a guard',
    'const a = 1\njest.mock("./x")\n;[1, 2].forEach(f)\n',
    ['mock ./x', 'f 1', 'f 2'],
  ],
  [
    'a `;` on the next line moves with its statement, and `(` still gets a guard',
    'const a = use\njest.mock("./x")\n;(f)(1)\n',
    ['mock ./x', 'f 1'],
  ],
  [
    'a `;` on the next line moves with its statement, and a template literal still gets a guard',
    'const a = f\njest.mock("./x")\n;`x`.length\n',
    ['mock ./x'],
  ],
  [
    'a `;` on the same line leaves one behind for `[`',
    'const a = 1\njest.mock("./x");[1, 2].forEach(f)\n',
    ['mock ./x', 'f 1', 'f 2'],
  ],
  [
    'a `;` at the end of the line leaves one behind for `[`',
    'const a = 1\njest.mock("./x");\n[1, 2].forEach(f)\n',
    ['mock ./x', 'f 1', 'f 2'],
  ],
  [
    'comments are looked past',
    'const a = 1\njest.mock("./x"); // c\n/* d */ [1, 2].forEach(f)\n',
    ['mock ./x', 'f 1', 'f 2'],
  ],
  [
    '`+` is guarded',
    'const a = f\njest.mock("./x");\n+use()\nf(typeof a)\n',
    ['mock ./x', 'use', 'f function'],
  ],
  [
    '`-` is guarded',
    'const a = f\njest.mock("./x");\n-use()\nf(typeof a)\n',
    ['mock ./x', 'use', 'f function'],
  ],
  ['`/` is guarded', 'const a = use\njest.mock("./x");\n/re/.test(f(1))\n', ['mock ./x', 'f 1']],
  [
    'a block-level move is guarded too',
    'function g() {\n  const a = 1\n  jest.mock("./x");\n  [1].forEach(f)\n}\ng()\n',
    ['mock ./x', 'f 1'],
  ],
  [
    'a moved const with its `;` on the next line still guards `[`',
    'use()\nconst k = 1\n;[k].forEach(f)\njest.mock("./x", () => k)\n',
    ['mock ./x', 'use', 'f 1'],
  ],
  [
    'a moved statement that opens with `(` does not call the directive before it',
    "'use strict'\nuse();\n(jest.mock('./x'))\n",
    ['mock ./x', 'use'],
  ],
]

for (const [name, source, expected] of RUNNABLE) {
  test(`asi: ${name}`, () => {
    const result = hoist(source, blockPolicy)
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(run(result.code), expected, result.code)
  })
}

test('asi: a stayer does not take the `;` a hoisted value left', () => {
  const result = hoist('use()\nconst v = vi.hoisted(() => 1)\n;[v].forEach(f)\n', topLevelPolicy)
  assert.deepEqual(run(result.code), ['use', 'f 1'])
})

test('asi: a moved import with its `;` on the next line still guards `[`', () => {
  const result = hoist("use()\nimport './y'\n;[1].map(f)\njest.mock('./x')\n", blockPolicy)
  assert.ok(statements(result.code).includes('use()'), result.code)
})

test('asi: a moved import with no `;` guards a following `[`', () => {
  const result = hoist("use()\nimport './y'\n[1].map(f)\njest.mock('./x')\n", blockPolicy)
  assert.ok(statements(result.code).includes('use()'), result.code)
})

test('asi: a moved import with a same-line `;` guards a following `(`', () => {
  const result = hoist("use()\nimport './y';(f)(1)\njest.mock('./x')\n", blockPolicy)
  assert.ok(statements(result.code).includes('use()'), result.code)
})

test('asi: a detached call at the start of a statement does not call the line before', () => {
  const result = hoist("import { f } from './a'\nconst a = 1\nf()\njest.mock('./a')\n", blockPolicy)
  assert.ok(statements(result.code).includes('const a = 1'), result.code)
})

test('asi: a detached call under an `if` stays under it', () => {
  const result = hoist("import { f } from './a'\nif (c) f()\njest.mock('./a')\n", blockPolicy)
  assert.ok(result.code.includes('if (c) (0, __provino_import_0__.f)()'), result.code)
})

test('asi: no guard is written when the statement stays first', () => {
  const result = hoist('jest.mock("./x");[1].forEach(f)\n', blockPolicy)
  assert.ok(!result.code.includes(';;') && !/\n;/.test(result.code), result.code)
})
