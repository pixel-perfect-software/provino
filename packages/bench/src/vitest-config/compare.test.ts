import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareTest, maskPaths, subsetOf, TEST_BAR_KEYS, unstablePaths } from './compare.ts'

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

test('a list of objects (projects) is compared as a subset, entry by entry', () => {
  const ours = [{ test: { name: 'a', include: ['x'] } }, { test: { name: 'b' } }]
  const theirs = [
    { test: { name: 'a', include: ['x'], extra: 1 }, resolve: {} },
    { test: { name: 'b' } },
  ]
  assert.equal(subsetOf(ours, theirs), true)
  assert.equal(subsetOf(ours, theirs.slice(0, 1)), false)
  assert.equal(subsetOf([{ test: { name: 'c' } }], [{ test: { name: 'a' } }]), false)
})

test('a list of RegExps nested in an object is contained, not matched entry by entry', () => {
  const regexp = (source: string) => ({ $regexp: source, flags: '' })
  assert.equal(
    subsetOf({ inline: [regexp('a')] }, { inline: [regexp('b'), regexp('a'), regexp('c')] }),
    true,
  )
  assert.equal(subsetOf({ inline: [regexp('z')] }, { inline: [regexp('a')] }), false)
})

test('what two reads of one config by Vitest differ on is masked on both sides', () => {
  const first = {
    execArgv: ['--a', '/tmp/vitest-1.localstorage'],
    name: 'x',
    projects: [{ n: 1, p: 11 }],
  }
  const second = {
    execArgv: ['--a', '/tmp/vitest-2.localstorage'],
    name: 'x',
    projects: [{ n: 1, p: 22 }],
  }
  const paths = unstablePaths(first, second)
  assert.deepEqual(paths.sort(), ['execArgv[1]', 'projects[0].p'])
  const ours = {
    execArgv: ['--a', '/tmp/vitest-99.localstorage'],
    name: 'x',
    projects: [{ n: 1, p: 33 }],
  }
  assert.deepEqual(maskPaths(ours, new Set(paths)), {
    execArgv: ['--a', '<unstable>'],
    name: 'x',
    projects: [{ n: 1, p: '<unstable>' }],
  })
  // A value that is stable between the two reads stays compared: a real difference still fails.
  const result = compareTest(
    { execArgv: ['--b'] },
    { ...DEFAULTS, root: ROOT, execArgv: ['--a'] },
    ROOT,
    DEFAULTS,
    '/work/empty',
    new Set(['execArgv']),
    undefined,
    new Set(paths),
  )
  assert.equal(result.differences.length, 1)
  assert.deepEqual(unstablePaths({ a: 1 }, { a: 1 }), [])
})
