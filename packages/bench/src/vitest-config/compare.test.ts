import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type CompareInputs,
  compareTest,
  firstDifference,
  matchesUnstable,
  TEST_BAR_KEYS,
  unstableLeaves,
} from './compare.ts'

const ROOT = '/work/app'
const DEFAULTS = {
  environment: 'node',
  include: ['**/*.test.ts'],
  testTimeout: 5000,
  root: '/work/empty',
  coverage: { provider: 'v8', reportsDirectory: './coverage', exclude: [], reporter: ['text'] },
}

/** One comparison: what Vitest resolves is its defaults for this root with the config's keys over them. */
function compare(
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
  more: Partial<CompareInputs> = {},
) {
  return compareTest({
    ours,
    theirs: { ...DEFAULTS, root: ROOT, ...theirs },
    root: ROOT,
    defaults: DEFAULTS,
    defaultsRoot: '/work/empty',
    given: new Set(Object.keys(ours)),
    ...more,
  })
}

test('the bar is the 30 keys of Track 11 F4, each once', () => {
  assert.equal(TEST_BAR_KEYS.length, 30)
  assert.equal(new Set(TEST_BAR_KEYS).size, 30)
})

test('a key equal to the default is not set and not compared', () => {
  const result = compare(
    {},
    { environment: 'node', include: ['**/*.test.ts'] },
    { given: new Set() },
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
  const missing = compare({}, { testTimeout: 77 }, { given: new Set() })
  assert.deepEqual(missing.differences, [{ key: 'testTimeout', ours: undefined, theirs: 77 }])
})

test('paths compare absolute, with the root as <root>, and the root default is the directory', () => {
  const result = compare(
    { setupFiles: ['./setup.ts'], dir: 'src', root: '.' },
    { setupFiles: ['/work/app/setup.ts'], dir: '/work/app/src', root: '/work/app' },
  )
  assert.deepEqual(result.differences, [])
})

test('name is its label and reporters are pairs, options included', () => {
  const ok = compare(
    { name: 'unit', reporters: [['verbose', { a: 1 }], 'dot'] },
    {
      name: { label: 'unit', color: 'blue' },
      reporters: [
        ['verbose', { a: 1 }],
        ['dot', {}],
      ],
    },
  )
  assert.deepEqual(ok.differences, [])
  const dropped = compare({ reporters: [['verbose']] }, { reporters: [['verbose', { a: 1 }]] })
  assert.equal(dropped.differences.length, 1)
})

test('a reader that drops a list entry, a key or an option is a difference', () => {
  // Lists are equal entry by entry: a subset is not enough.
  assert.notEqual(firstDifference(['a'], ['a', 'b'], undefined), null)
  assert.notEqual(firstDifference(['a', 'b'], ['a'], undefined), null)
  assert.equal(firstDifference(['a', 'b'], ['a', 'b'], undefined), null)
  // An object key only Vitest has must be what Vitest resolves for an empty directory.
  assert.notEqual(firstDifference({ a: 1 }, { a: 1, b: 2 }, { b: 3 }), null)
  assert.equal(firstDifference({ a: 1 }, { a: 1, b: 2 }, { b: 2 }), null)
  // A key only ours has is a difference unless it is undefined.
  assert.notEqual(firstDifference({ a: 1, extra: 1 }, { a: 1 }, {}), null)
  assert.equal(firstDifference({ a: 1, extra: undefined }, { a: 1 }, {}), null)
  // A function is its source, which the config's transform changes; a RegExp is its source and flags.
  assert.equal(firstDifference({ $function: 'a' }, { $function: 'b' }, undefined), null)
  assert.notEqual(
    firstDifference({ $regexp: 'a', flags: '' }, { $regexp: 'b', flags: '' }, undefined),
    null,
  )
  // A list of projects goes entry by entry, and its length counts.
  assert.notEqual(
    firstDifference(
      [{ test: { name: 'a' } }],
      [{ test: { name: 'a' } }, { test: { name: 'b' } }],
      undefined,
    ),
    null,
  )
})

test("coverage.exclude: the config's own entries, then exactly what Vitest appends", () => {
  const tail = [
    'tests/**/*.spec.ts',
    '/work/app/vitest.config.ts',
    ...['vitest', 'vite'].flatMap((name) =>
      ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map((ext) => `${name}.config.${ext}`),
    ),
    '**/virtual:*',
    '**/__x00__*',
    '**/node_modules/**',
  ]
  const theirs = (own: string[]) => ({
    include: ['tests/**/*.spec.ts'],
    coverage: { ...DEFAULTS.coverage, exclude: [...own, ...tail] },
  })
  const inputs = { configFile: '/work/app/vitest.config.ts' }
  const ok = compare(
    {
      include: ['tests/**/*.spec.ts'],
      coverage: { ...DEFAULTS.coverage, exclude: ['src/gen/**'] },
    },
    theirs(['src/gen/**']),
    inputs,
  )
  assert.deepEqual(ok.differences, [])
  // The config's own entry dropped by the reader.
  const dropped = compare(
    { include: ['tests/**/*.spec.ts'], coverage: { ...DEFAULTS.coverage, exclude: [] } },
    theirs(['src/gen/**']),
    inputs,
  )
  assert.equal(dropped.differences.length, 1)
  // Something Vitest does not append.
  const extra = compare(
    { include: ['tests/**/*.spec.ts'], coverage: { ...DEFAULTS.coverage, exclude: [] } },
    { ...theirs([]), coverage: { ...DEFAULTS.coverage, exclude: ['surprise', ...tail] } },
    inputs,
  )
  assert.equal(extra.differences.length, 1)
})

test("coverage.include: a name with no glob is name/** on Vitest's side, nothing else is rewritten", () => {
  const base = { ...DEFAULTS.coverage }
  const ok = compare(
    { coverage: { ...base, include: ['src', './lib/', 'a/**'] } },
    { coverage: { ...base, include: ['src/**', './lib/**', 'a/**'] } },
  )
  assert.deepEqual(ok.differences, [])
  const wrong = compare(
    { coverage: { ...base, include: ['./src'] } },
    { coverage: { ...base, include: ['src/**'] } },
  )
  assert.equal(wrong.differences.length, 1)
})

test('what two reads of one config by Vitest differ on: found by value, masked or checked', () => {
  const first = {
    execArgv: ['--a', '/tmp/vitest-1.localstorage'],
    name: 'x',
    sequence: { seed: 11, hooks: 'stack' },
  }
  const second = {
    execArgv: ['--a', '/tmp/vitest-2.localstorage'],
    name: 'x',
    sequence: { seed: 22, hooks: 'stack' },
  }
  const leaves = unstableLeaves(first, second)
  assert.deepEqual(leaves.map((leaf) => leaf.path).sort(), ['execArgv[1]', 'sequence.seed'])
  assert.equal(
    matchesUnstable(
      '/tmp/vitest-99.localstorage',
      '/tmp/vitest-1.localstorage',
      '/tmp/vitest-2.localstorage',
    ),
    true,
  )
  assert.equal(
    matchesUnstable(
      '/tmp/other-99.localstorage',
      '/tmp/vitest-1.localstorage',
      '/tmp/vitest-2.localstorage',
    ),
    false,
  )
  assert.equal(matchesUnstable(33, 11, 22), true)
  assert.equal(matchesUnstable('33', 11, 22), false)
  // A list whose length differs between the reads is never masked: nothing is found.
  assert.deepEqual(unstableLeaves({ a: [1] }, { a: [1, 2] }), [
    { path: 'a', first: [1], second: [1, 2] },
  ])
  assert.deepEqual(unstableLeaves({ a: 1 }, { a: 1 }), [])
})

test('an unstable leaf is checked under a key the config sets, and masked under one it does not', () => {
  const reads = (seed: number, arg: string, name: string) => ({
    ...DEFAULTS,
    root: ROOT,
    name,
    sequence: { hooks: 'stack', seed },
    execArgv: ['--a', arg],
  })
  // The config names sequence and execArgv: their unstable leaves are verified, not masked.
  const first = reads(1, '/tmp/vitest-1.ls', 'unit-1')
  const second = reads(2, '/tmp/vitest-2.ls', 'unit-2')
  const named = compare(
    {
      sequence: { hooks: 'stack', seed: 999 },
      execArgv: ['--a', '/tmp/vitest-777.ls'],
      name: 'unit-3',
    },
    first,
    { again: second },
  )
  assert.deepEqual(named.differences, [])
  assert.deepEqual(named.masked, [])
  assert.deepEqual([...named.verified].sort(), ['execArgv[1]', 'name', 'sequence.seed'])
  // A value of another shape than both readings is a difference, never masked.
  const wrong = compare(
    {
      sequence: { hooks: 'stack', seed: 'not a number' },
      execArgv: ['--a', '/tmp/somewhere-else'],
      name: 'x',
    },
    first,
    { again: second },
  )
  assert.equal(wrong.differences.length, 3)
  // The config names none of them (Vitest derives the name of an unnamed project): masked, and said so.
  const derived = compare(
    {},
    { name: 'unit-1' },
    { again: { ...DEFAULTS, root: ROOT, name: 'unit-2' } },
  )
  assert.deepEqual(derived.masked, ['name'])
  assert.deepEqual(derived.differences, [])
})
