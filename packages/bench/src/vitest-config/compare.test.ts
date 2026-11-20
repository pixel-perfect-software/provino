import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareTest, subsetOf, TEST_BAR_KEYS } from './compare.ts'

const ROOT = '/work/app'
const DEFAULTS = {
  environment: 'node',
  include: ['**/*.test.ts'],
  testTimeout: 5000,
  root: '/work/empty',
}
/** What Vitest resolves for the config: its defaults (for this root) with the config's keys over them. */
const compare = (
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
  given: readonly string[] = [],
) =>
  compareTest(
    ours,
    { ...DEFAULTS, root: ROOT, ...theirs },
    ROOT,
    DEFAULTS,
    '/work/empty',
    new Set(given),
  )

test('the bar is the 30 keys of Track 11 F4, each once', () => {
  assert.equal(TEST_BAR_KEYS.length, 30)
  assert.equal(new Set(TEST_BAR_KEYS).size, 30)
})

test('a key equal to the default is not set and not compared', () => {
  const result = compare(
    { environment: 'node' },
    { environment: 'node', include: ['**/*.test.ts'] },
  )
  assert.deepEqual(result.compared, [])
  assert.deepEqual(result.differences, [])
})

test('a key the config sets is compared, and a difference names both values', () => {
  const same = compare(
    { environment: 'jsdom', testTimeout: 9 },
    { environment: 'jsdom', testTimeout: 9 },
  )
  assert.deepEqual(same.compared, ['environment', 'testTimeout'])
  assert.deepEqual(same.differences, [])
  const different = compare({ environment: 'happy-dom' }, { environment: 'jsdom' })
  assert.deepEqual(different.differences, [
    { key: 'environment', ours: 'happy-dom', theirs: 'jsdom' },
  ])
  const missing = compare({}, { testTimeout: 77 })
  assert.deepEqual(missing.differences, [{ key: 'testTimeout', ours: undefined, theirs: 77 }])
})

test('paths compare absolute, with the root as <root>, and the root default is the directory', () => {
  const result = compare(
    { setupFiles: ['./setup.ts'], dir: 'src', root: '.' },
    { setupFiles: ['/work/app/setup.ts'], dir: '/work/app/src', root: '/work/app' },
  )
  assert.deepEqual(result.compared, ['setupFiles', 'dir'])
  assert.deepEqual(result.differences, [])
})

test("name is its label, reporters are pairs, and an object is a subset of Vitest's", () => {
  const result = compare(
    { name: 'unit', reporters: ['verbose'], sequence: { hooks: 'list' } },
    {
      name: { label: 'unit', color: 'blue' },
      reporters: [['verbose', {}]],
      sequence: { hooks: 'list', seed: 1, shuffle: false },
    },
  )
  assert.deepEqual(result.differences, [])
  assert.equal(subsetOf({ a: 1 }, { a: 1, b: 2 }), true)
  assert.equal(subsetOf({ a: 2 }, { a: 1, b: 2 }), false)
  assert.equal(subsetOf([1, 2], [1, 2, 3]), false)
})
