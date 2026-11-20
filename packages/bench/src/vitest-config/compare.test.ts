import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type CompareInputs, compareTest, firstDifference, TEST_BAR_KEYS } from './compare.ts'

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

test('coverage.exclude: the root block, then one block per project, each as Vitest builds it', () => {
  const own = ['src/gen/**']
  const fixed = [
    ...['vitest', 'vite'].flatMap((name) =>
      ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map((ext) => `${name}.config.${ext}`),
    ),
    '**/virtual:*',
    '**/__x00__*',
    '**/node_modules/**',
  ]
  const project = {
    name: 'pkg',
    root: '/work/app/pkg',
    include: ['pkg/**/*.test.ts'],
    setupFiles: ['/work/app/pkg/setup.ts'],
    config: undefined,
    allowExternal: false,
  }
  const base = { include: ['tests/**/*.spec.ts'], projects: [{ test: { name: 'pkg' } }] }
  const blocks = [
    'tests/**/*.spec.ts',
    '/work/app/vitest.config.ts',
    ...fixed,
    'setup.ts',
    'pkg/**/*.test.ts',
    ...fixed,
  ]
  const theirs = (list: string[]) => ({
    ...base,
    coverage: { ...DEFAULTS.coverage, exclude: list },
  })
  const ours = { include: base.include, coverage: { ...DEFAULTS.coverage, exclude: own } }
  const inputs = {
    configFile: '/work/app/vitest.config.ts',
    theirProjects: [project],
    ourProjects: [{ name: 'pkg', root: '/work/app/pkg' }],
  }
  assert.deepEqual(compare(ours, theirs([...own, ...blocks]), inputs).differences, [])
  // An entry Vitest's blocks don't explain, a missing block, or the reader's entries out of place.
  assert.equal(compare(ours, theirs([...own, ...blocks, 'stray/**']), inputs).differences.length, 1)
  assert.equal(
    compare(ours, theirs([...own, ...blocks.slice(0, 17)]), inputs).differences.length,
    1,
  )
  assert.equal(compare(ours, theirs(['other/**', ...blocks]), inputs).differences.length, 1)
})

test("coverage.htmlDir is Vitest's inference unless the config names it", () => {
  const coverage = { ...DEFAULTS.coverage, reporter: ['html'] }
  const inferred = { ...coverage, htmlDir: '/work/app/coverage' }
  assert.deepEqual(compare({ coverage }, { coverage: inferred }).differences, [])
  const wrong = { ...coverage, htmlDir: '/work/app/elsewhere' }
  assert.equal(compare({ coverage }, { coverage: wrong }).differences.length, 1)
})

test("alias: the reader's ordered pairs equal Vitest's beyond its own entries", () => {
  const own = { find: 'a', replacement: '/x' }
  const regex = { find: { $regexp: '^b', flags: '' }, replacement: '/y' }
  const vitestOwn = { find: '/^vitest/', replacement: '/v' }
  const inputs = { defaultAlias: [vitestOwn], given: new Set(['alias']) }
  const ok = compare(
    { alias: {} },
    {},
    {
      ...inputs,
      ourAlias: [own, regex],
      theirAlias: [vitestOwn, { ...own, customResolver: undefined }, regex],
    },
  )
  assert.deepEqual(ok.differences, [])
  const reordered = compare(
    { alias: {} },
    {},
    {
      ...inputs,
      ourAlias: [regex, own],
      theirAlias: [vitestOwn, own, regex],
    },
  )
  assert.equal(reordered.differences.length, 1)
  const dropped = compare(
    { alias: {} },
    {},
    {
      ...inputs,
      ourAlias: [own],
      theirAlias: [vitestOwn, own, regex],
    },
  )
  assert.equal(dropped.differences.length, 1)
})

test("projects: the reader's names and roots equal Vitest's resolved projects", () => {
  const theirs = (name: string) => ({
    name,
    root: '/work/app/pkg',
    include: [],
    setupFiles: [],
    allowExternal: false,
  })
  const inputs = { given: new Set(['projects']) }
  const ok = compare(
    { projects: [] },
    {},
    {
      ...inputs,
      ourProjects: [{ name: 'a', root: '/work/app/pkg' }],
      theirProjects: [theirs('a')],
    },
  )
  assert.deepEqual(ok.differences, [])
  const renamed = compare(
    { projects: [] },
    {},
    {
      ...inputs,
      ourProjects: [{ name: 'b', root: '/work/app/pkg' }],
      theirProjects: [theirs('a')],
    },
  )
  assert.equal(renamed.differences.length, 1)
  // The same projects in another order are the same projects.
  const swapped = compare(
    { projects: [] },
    {},
    {
      ...inputs,
      ourProjects: [
        { name: 'b', root: '/work/app/pkg' },
        { name: 'a', root: '/work/app/pkg' },
      ],
      theirProjects: [theirs('a'), theirs('b')],
    },
  )
  assert.deepEqual(swapped.differences, [])
  const unknown = compare({ projects: [] }, {}, { ...inputs, ourProjects: [], theirProjects: null })
  assert.equal(unknown.skipped.length, 1)
})
