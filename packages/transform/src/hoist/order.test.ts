// The order a hoist leaves statements in: the review's Blocker layouts by name, the TSX layout
// through the real pipeline, and a seeded property test over generated files.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseForHoist } from './parse.ts'
import { assertOrder, blockPipeline, hoist } from './test-helpers.ts'
import { blockPolicy, topLevelPolicy } from './test-policies.ts'

test('order: the statement touching the last stayer does not stay first', () => {
  const result = hoist(
    'jest.mock("./a")\njest.unmock("./a")\nconst x = require("./x")\nuse(x)\njest.mock("./c")\n',
    blockPolicy,
  )
  assertOrder(
    result.code,
    'jest.mock("./a")',
    'jest.unmock("./a")',
    'jest.mock("./c")',
    'const x = require("./x")',
  )
})

test('order: a mock below an import between stayers loads before that import', () => {
  const result = hoist(
    'import a from "./a"\nimport b from "./b"\nconst z = 1\nimport c from "./c"\njest.mock("./b")\nuse(a, b, c, z)\n',
    blockPolicy,
  )
  assertOrder(
    result.code,
    'jest.mock("./b")',
    'await __provino_import__("./a")',
    'await __provino_import__("./b")',
    'await __provino_import__("./c")',
    'const z = 1',
  )
})

test('order: a hoisted value reading an earlier one stays below it', () => {
  const result = hoist(
    'const a = vi.hoisted(() => 1)\nconst b = vi.hoisted(() => a + 1)\nuse(b)\nvi.mock("./x", () => ({ b }))\n',
    topLevelPolicy,
  )
  assertOrder(
    result.code,
    'const a = vi.hoisted',
    'const b = vi.hoisted',
    'vi.mock("./x"',
    'use(b)',
  )
})

test('order: moves with nothing staying keep the queue order', () => {
  const result = hoist('import a from "./a"\njest.mock("./a")\njest.mock("./b")\n', blockPolicy)
  assertOrder(
    result.code,
    'jest.mock("./a")',
    'jest.mock("./b")',
    'await __provino_import__("./a")',
  )
})

test('order: statements touching one another on one line are merged and keep their order', () => {
  const result = hoist(
    'use();jest.mock("./a");jest.mock("./b");use2();jest.mock("./c")\n',
    blockPolicy,
  )
  assertOrder(result.code, 'jest.mock("./a")', 'jest.mock("./b")', 'jest.mock("./c")', 'use()')
})

test('order: a guarded call leaves its block and keeps its order', () => {
  const result = hoist(
    'use()\nvi.mock("./a")\nif (import.meta.vitest) {\n  vi.mock("./b")\n}\nvi.mock("./c")\n',
    topLevelPolicy,
  )
  assertOrder(result.code, 'vi.mock("./a")', 'vi.mock("./b")', 'vi.mock("./c")', 'use()')
})

test('order: a TSX test mocks before its imports, through the real pipeline', () => {
  // Oxc writes `var _jsxFileName` straight after the last import, so the last import touches the
  // first statement that stays. This hits nearly every TSX test.
  const record = blockPipeline().transform({
    filename: '/virtual/a.test.tsx',
    source:
      'import { render } from "@testing-library/react"\nimport { Comp } from "./comp"\nimport { api } from "./api"\njest.mock("./api")\ntest("t", () => { render(<Comp a={api as unknown} />) })\n',
    role: 'test',
    consumer: 'import',
    instrument: false,
  })
  assert.deepEqual(record.diagnostics, [])
  assertOrder(
    record.code,
    'jest.mock("./api")',
    'await __provino_import__("@testing-library/react")',
    'await __provino_import__("./comp")',
    'await __provino_import__("./api")',
    '_jsxFileName =',
    'test("t"',
  )
})

// ---------------------------------------------------------------------------------------------
// The property test: generated files, with the invariants every output must keep.

type Kind = 'import' | 'mock' | 'stay' | 'const'

interface Generated {
  readonly source: string
  readonly counts: Readonly<Record<Kind, number>>
}

const SEPARATORS = ['\n', '\n', '\n', ';\n', ';', '; ', ' // c\n', '\r\n', '\n\n'] as const

/** A small seeded generator, so a failing case reproduces. */
function seeded(start: number): (below: number) => number {
  let seed = start
  return (below) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return (seed >>> 12) % below
  }
}

function generate(next: (below: number) => number, typescript: boolean): Generated {
  const counts = { import: 0, mock: 0, stay: 0, const: 0 }
  const statements: string[] = []
  const size = 1 + next(8)
  for (let i = 0; i < size; i++) {
    const kind = next(4)
    if (kind === 0) {
      statements.push(`import i${counts.import} from "./i${counts.import}"`)
      counts.import++
    } else if (kind === 1) {
      statements.push(`jest.mock("./m${counts.mock}")`)
      counts.mock++
    } else if (kind === 2) {
      statements.push(`stay${counts.stay}()`)
      counts.stay++
    } else {
      const annotation = typescript ? ': number' : ''
      statements.push(`const c${counts.const}${annotation} = ${counts.const}`)
      statements.push(`jest.mock("./m${counts.mock}", () => c${counts.const})`)
      counts.mock++
      counts.const++
    }
  }
  let source = ''
  for (const statement of statements) {
    source += statement + (SEPARATORS[next(SEPARATORS.length)] ?? '\n')
  }
  // The TypeScript step removes an import nothing reads.
  if (typescript && counts.import > 0) {
    const names = Array.from({ length: counts.import }, (_, i) => `i${i}`)
    source += `;void [${names.join(', ')}]\n`
  }
  return { source, counts }
}

function positions(code: string, count: number, text: (i: number) => string): number[] {
  return Array.from({ length: count }, (_, i) => {
    const at = code.indexOf(text(i))
    assert.notEqual(at, -1, `${text(i)} was dropped`)
    return at
  })
}

function assertAscending(values: readonly number[], what: string): void {
  for (let i = 1; i < values.length; i++) {
    assert.ok((values[i] ?? 0) > (values[i - 1] ?? 0), `${what} order`)
  }
}

function assertInvariants(code: string, counts: Generated['counts'], filename: string): void {
  const parsed = parseForHoist(filename, code)
  assert.ok(parsed.ok, 'the output parses')
  const mocks = positions(code, counts.mock, (i) => `"./m${i}"`)
  const imports = positions(code, counts.import, (i) => `"./i${i}"`)
  const stays = positions(code, counts.stay, (i) => `stay${i}()`)
  const consts = positions(code, counts.const, (i) => `const c${i}`)
  assertAscending(mocks, 'mock')
  assertAscending(imports, 'import')
  assertAscending(stays, 'stayer')
  assertAscending(consts, 'const')
  const lastMock = Math.max(...mocks)
  const firstMock = Math.min(...mocks)
  for (const at of imports) assert.ok(at > lastMock, 'an import loads before a mock')
  for (const at of stays) {
    assert.ok(at > lastMock, 'a stayer runs before a mock')
    for (const load of imports) assert.ok(at > load, 'a stayer runs before an import')
  }
  for (const at of consts) assert.ok(at < firstMock, 'a const a factory reads comes after a call')
}

function check(source: string, code: string, counts: Generated['counts'], filename: string): void {
  try {
    assertInvariants(code, counts, filename)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    assert.fail(`${reason}\nsource: ${JSON.stringify(source)}\noutput: ${JSON.stringify(code)}`)
  }
}

test('order: 3,000 generated JavaScript files keep every order invariant', () => {
  const next = seeded(12345)
  let hoisted = 0
  for (let i = 0; i < 3000; i++) {
    const { source, counts } = generate(next, false)
    if (counts.mock === 0) continue
    const result = hoist(source, blockPolicy)
    assert.deepEqual(result.diagnostics, [], source)
    check(source, result.code, counts, 'case.js')
    hoisted++
  }
  assert.ok(hoisted > 2000, `only ${hoisted} files hoisted anything`)
})

test('order: 500 generated TypeScript files keep every order invariant through the pipeline', () => {
  const next = seeded(67890)
  const pipeline = blockPipeline()
  let hoisted = 0
  for (let i = 0; i < 500; i++) {
    const { source, counts } = generate(next, true)
    if (counts.mock === 0) continue
    const record = pipeline.transform({
      filename: '/virtual/case.test.ts',
      source,
      role: 'test',
      consumer: 'import',
      instrument: false,
    })
    assert.deepEqual(record.diagnostics, [], source)
    check(source, record.code, counts, 'case.ts')
    hoisted++
  }
  assert.ok(hoisted > 300, `only ${hoisted} files hoisted anything`)
})
