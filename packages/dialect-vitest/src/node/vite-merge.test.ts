// B25c: the rebuilt `mergeConfig` against the real one (`vitest/config` re-exports Vite's).
import assert from 'node:assert/strict'
import { test } from 'provino'
import { mergeConfig as viteMergeConfig } from 'vitest/config'
import { mergeConfig } from './vite-merge.ts'

type Rec = Record<string, unknown>
const real = viteMergeConfig as unknown as (a: Rec, b: Rec, isRoot?: boolean) => Rec

const cases: readonly (readonly [string, Rec, Rec])[] = [
  ['scalars: the override wins', { test: { a: 1, b: 2 } }, { test: { a: 3 } }],
  [
    'arrays concatenate',
    { test: { include: ['a'] } },
    { test: { include: ['b'], exclude: ['c'] } },
  ],
  ['an array and a scalar', { test: { include: ['a'] } }, { test: { include: 'b' } }],
  [
    'null and undefined in the override are skipped',
    { test: { a: 1 } },
    { test: { a: null, b: undefined } },
  ],
  [
    'nested objects merge',
    { test: { x: { y: { z: 1 }, w: 1 } } },
    { test: { x: { y: { q: 2 } } } },
  ],
  [
    'alias objects merge',
    { resolve: { alias: { '@': '/a' } } },
    { resolve: { alias: { '~': '/b' } } },
  ],
  [
    'alias lists put the override first, and trim a trailing slash from both sides',
    { resolve: { alias: [{ find: 'a/', replacement: '/x/' }] } },
    { resolve: { alias: { b: '/y' } } },
  ],
  ['a top-level alias', { alias: { a: '/x' } }, { alias: [{ find: 'b', replacement: '/y' }] }],
  ['assetsInclude', { assetsInclude: ['a'] }, { assetsInclude: /b/ }],
  ['noExternal true wins', { ssr: { noExternal: ['a'] } }, { ssr: { noExternal: true } }],
  ['plugins concatenate', { plugins: [{ name: 'a' }] }, { plugins: [{ name: 'b' }] }],
  [
    'a class instance is replaced, not merged',
    { test: { d: new Date(0) } },
    { test: { d: { a: 1 } } },
  ],
]

for (const [name, defaults, overrides] of cases) {
  test(`mergeConfig: ${name}`, () => {
    assert.deepEqual(mergeConfig(defaults, overrides), real(defaults, overrides))
  })
}

test('mergeConfig as a nested merge (isRoot false) matches', () => {
  const a = { alias: { a: '/x' } }
  const b = { alias: { b: '/y' } }
  assert.deepEqual(mergeConfig(a, b, false), real(a, b, false))
})

test('a config callback is refused as Vite refuses it', () => {
  assert.throws(() => mergeConfig((() => ({})) as unknown as Rec, {}), /callback/)
  assert.throws(() => real((() => ({})) as unknown as Rec, {}), /callback/)
})

test('the inputs are not changed', () => {
  const defaults = { test: { include: ['a'] } }
  const overrides = { test: { include: ['b'] } }
  mergeConfig(defaults, overrides)
  assert.deepEqual(defaults, { test: { include: ['a'] } })
  assert.deepEqual(overrides, { test: { include: ['b'] } })
})
