// Source-map probes (T3.4): each position in the hoisted output traced with trace-mapping back to
// the exact line and column of the original. Moved statements, rewritten references and
// block-level hoists, under both policies.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping'
import type { HoistPolicy } from '@provino/types'
import { hoist } from './test-helpers.ts'
import { blockPolicy, topLevelPolicy } from './test-policies.ts'

interface Spot {
  /** Text to find in the text (the output for `gen`, the input for `src`). */
  readonly text: string
  /** Characters past the start of `text` the position is taken at. */
  readonly delta?: number
}

function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset).split('\n')
  return { line: before.length, column: before.at(-1)?.length ?? 0 }
}

function locate(text: string, spot: Spot): { line: number; column: number } {
  const at = text.indexOf(spot.text)
  assert.ok(at >= 0, `${JSON.stringify(spot.text)} is not in:\n${text}`)
  return lineAndColumn(text, at + (spot.delta ?? 0))
}

interface Probe {
  readonly name: string
  readonly policy: HoistPolicy
  readonly source: string
  readonly gen: Spot
  readonly src: Spot
}

const IMPORTING =
  "import { x } from './a'\nconst before = 1\nfoo(x)\njest.mock('./a', () => ({\n  x: 1,\n}))\nexport { x }\nexport const y = { x }\n"
const DESCRIBED =
  "describe('s', () => {\n  const k = 1\n  jest.mock('./b')\n  it('t', () => {})\n})\n"
const PURE = "foo()\nconst answer = 6 * 7\njest.mock('./a', () => answer)\n"
const VITEST =
  "import { a } from './a'\nimport { vi } from 'vitest'\nconst h = vi.hoisted(() => ({ n: 1 }))\nuse(a)\nvi.mock(import('./a'))\n"
const GUARDED = "foo()\nif (import.meta.vitest) {\n  vi.mock('./g')\n}\n"
const AWAITED = 'foo()\nawait vi.hoisted(async () => 1)\n'
const REEXPORT = "jest.mock('./a')\nexport { q as r } from './q'\n"

const probes: readonly Probe[] = [
  {
    name: 'a moved call',
    policy: blockPolicy,
    source: IMPORTING,
    gen: { text: 'jest.mock(' },
    src: { text: 'jest.mock(' },
  },
  {
    name: 'a property inside a moved call',
    policy: blockPolicy,
    source: IMPORTING,
    gen: { text: 'mock(' },
    src: { text: 'mock(' },
  },
  {
    name: 'the second line of a moved factory',
    policy: blockPolicy,
    source: IMPORTING,
    gen: { text: 'x: 1,' },
    src: { text: 'x: 1,' },
  },
  {
    name: 'the last line of a moved call',
    policy: blockPolicy,
    source: IMPORTING,
    gen: { text: '}))' },
    src: { text: '}))' },
  },
  {
    name: 'a rewritten import line',
    policy: blockPolicy,
    source: IMPORTING,
    gen: { text: 'const __provino_import_0__' },
    src: { text: 'import { x }' },
  },
  {
    name: 'a rewritten reference',
    policy: blockPolicy,
    source: IMPORTING,
    gen: { text: 'foo(__provino_import_0__.x)', delta: 4 },
    src: { text: 'foo(x)', delta: 4 },
  },
  {
    name: 'the code after a rewritten reference',
    policy: blockPolicy,
    source: IMPORTING,
    gen: { text: 'export const y' },
    src: { text: 'export const y' },
  },
  {
    name: 'a statement that did not move',
    policy: blockPolicy,
    source: IMPORTING,
    gen: { text: 'const before' },
    src: { text: 'const before' },
  },
  {
    name: 'a statement pushed down by hoisting',
    policy: blockPolicy,
    source: IMPORTING,
    gen: { text: 'foo(' },
    src: { text: 'foo(' },
  },
  {
    name: 'a shorthand property reference',
    policy: blockPolicy,
    source: IMPORTING,
    gen: { text: 'y = { x: __provino_import_0__.x }', delta: 6 },
    src: { text: 'y = { x }', delta: 6 },
  },
  {
    name: 'an export statement with a rewritten specifier',
    policy: blockPolicy,
    source: IMPORTING,
    gen: { text: 'export { __provino_ref_0__' },
    src: { text: 'export { x }' },
  },
  {
    name: 'a call hoisted inside its own block',
    policy: blockPolicy,
    source: DESCRIBED,
    gen: { text: "jest.mock('./b')" },
    src: { text: "jest.mock('./b')" },
  },
  {
    name: 'a statement in a block that did not move',
    policy: blockPolicy,
    source: DESCRIBED,
    gen: { text: 'const k = 1' },
    src: { text: 'const k = 1' },
  },
  {
    name: 'a statement after a block-level hoist',
    policy: blockPolicy,
    source: DESCRIBED,
    gen: { text: "it('t'" },
    src: { text: "it('t'" },
  },
  {
    name: 'a hoisted pure const',
    policy: blockPolicy,
    source: PURE,
    gen: { text: 'const answer' },
    src: { text: 'const answer' },
  },
  {
    name: 'a call hoisted with its const',
    policy: blockPolicy,
    source: PURE,
    gen: { text: 'jest.mock(' },
    src: { text: 'jest.mock(' },
  },
  {
    name: 'a reference inside a moved factory',
    policy: blockPolicy,
    source: PURE,
    gen: { text: '() => answer', delta: 6 },
    src: { text: '() => answer', delta: 6 },
  },
  {
    name: 'code pushed down by a hoisted const and call',
    policy: blockPolicy,
    source: PURE,
    gen: { text: 'foo()' },
    src: { text: 'foo()' },
  },
  {
    name: 'a runner import kept first',
    policy: topLevelPolicy,
    source: VITEST,
    gen: { text: 'import { vi }' },
    src: { text: 'import { vi }' },
  },
  {
    name: 'a hoisted declaration',
    policy: topLevelPolicy,
    source: VITEST,
    gen: { text: 'const h = vi.hoisted' },
    src: { text: 'const h = vi.hoisted' },
  },
  {
    name: 'a call inside a hoisted declaration',
    policy: topLevelPolicy,
    source: VITEST,
    gen: { text: 'hoisted(' },
    src: { text: 'hoisted(' },
  },
  {
    name: 'a hoisted mock call',
    policy: topLevelPolicy,
    source: VITEST,
    gen: { text: 'vi.mock(' },
    src: { text: 'vi.mock(' },
  },
  {
    name: 'a rewritten import() argument',
    policy: topLevelPolicy,
    source: VITEST,
    gen: { text: "vi.mock('./a')", delta: 8 },
    src: { text: 'vi.mock(import', delta: 8 },
  },
  {
    name: 'a rewritten import line under the top-level policy',
    policy: topLevelPolicy,
    source: VITEST,
    gen: { text: 'const __provino_import_0__' },
    src: { text: "import { a } from './a'" },
  },
  {
    name: 'a rewritten reference under the top-level policy',
    policy: topLevelPolicy,
    source: VITEST,
    gen: { text: 'use(__provino_import_0__.a)', delta: 4 },
    src: { text: 'use(a)', delta: 4 },
  },
  {
    name: 'a call under a guard',
    policy: topLevelPolicy,
    source: GUARDED,
    gen: { text: "vi.mock('./g')" },
    src: { text: "vi.mock('./g')" },
  },
  {
    name: 'an awaited hoisted value',
    policy: topLevelPolicy,
    source: AWAITED,
    gen: { text: 'await vi.hoisted' },
    src: { text: 'await vi.hoisted' },
  },
  {
    name: 'a re-export turned into an import',
    policy: blockPolicy,
    source: REEXPORT,
    gen: { text: 'const __provino_import_0__' },
    src: { text: 'export { q' },
  },
]

for (const probe of probes) {
  test(`map: ${probe.name} traces to its original line and column`, () => {
    const result = hoist(probe.source, probe.policy)
    assert.deepEqual(result.diagnostics, [])
    assert.notEqual(result.map, null)
    const traced = new TraceMap({
      version: 3,
      file: null,
      sources: [...(result.map?.sources ?? [])],
      names: [...(result.map?.names ?? [])],
      mappings: result.map?.mappings ?? '',
    })
    const generated = locate(result.code, probe.gen)
    const original = originalPositionFor(traced, generated)
    assert.deepEqual(
      { line: original.line, column: original.column },
      locate(probe.source, probe.src),
      `generated ${generated.line}:${generated.column} in:\n${result.code}`,
    )
  })
}

test('map: a file with nothing to hoist has no map', () => {
  assert.equal(hoist('foo()\n', blockPolicy).map, null)
})

test('map: the map names the file it maps from', () => {
  const result = hoist("foo()\njest.mock('./a')\n", blockPolicy)
  assert.deepEqual(result.map?.sources, ['case.js'])
})

test('map: the probe table has at least 22 probes', () => {
  assert.ok(probes.length >= 22)
})
