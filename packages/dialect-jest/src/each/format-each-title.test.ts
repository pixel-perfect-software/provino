// T5.4: `formatEachTitle` against the real jest-each 30.5.2, in-process. The oracle is jest-each's
// own `bind`, handed a `test` that records the title it is given, so a table of any kind goes
// through the same code Jest runs. (The recorded titles of both runners are held by the runtime
// corpus, `@provino/harness` `fixtures/runtime/each-*`.)
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createBehaviourLoader, resolvePolicy } from '@provino/policy'
import type { FormatEachTitle } from '@provino/types'
import { jestPolicy } from '../dialect.ts'
import { formatEachTitle } from './format-each-title.ts'

type Recorder = ((title: string, fn?: unknown, timeout?: unknown) => void) & {
  skip: Recorder
  only: Recorder
  concurrent: Recorder
}

interface JestEach {
  withGlobal(g: unknown): (
    table: unknown,
    ...data: unknown[]
  ) => {
    test: (title: string, fn: unknown) => void
    describe: (title: string, fn: unknown) => void
  }
}

// jest-each is a dependency of jest-circus, which jest-config depends on: resolve it from there.
const circus = createRequire(fileURLToPath(import.meta.resolve('jest-config'))).resolve(
  'jest-circus',
)
const jestEach = (createRequire(circus)('jest-each') as { default: JestEach }).default

/** The titles real jest-each gives a table, in row order. A bad table gives `[]`. */
function jestTitles(title: string, table: unknown, ...data: unknown[]): string[] {
  const titles: string[] = []
  const recorder = (): Recorder => {
    const record = ((given: string) => {
      titles.push(given)
    }) as Recorder
    record.skip = record
    record.only = record
    record.concurrent = record
    return record
  }
  const g = {
    test: recorder(),
    it: recorder(),
    xit: recorder(),
    fit: recorder(),
    xtest: recorder(),
    describe: recorder(),
    fdescribe: recorder(),
    xdescribe: recorder(),
  }
  jestEach
    .withGlobal(g)(table, ...data)
    .test(title, () => {})
  return titles
}

/** The row core hands the formatter: an array or an object as it is, anything else a one-item list. */
function rowOf(item: unknown): readonly unknown[] | Readonly<Record<string, unknown>> {
  if (Array.isArray(item)) return item
  if (typeof item === 'object' && item !== null) return item as Record<string, unknown>
  return [item]
}

function ourTitles(title: string, items: readonly unknown[]): string[] {
  return items.map((item, index) => formatEachTitle(title, rowOf(item), index))
}

class Point {
  x = 1
  y = 2
}
const cyclic: Record<string, unknown> = { name: 'cyclic' }
cyclic.self = cyclic

/** Every kind of value a title can hold, as cells. */
const values: readonly unknown[] = [
  'text',
  '',
  'two\nlines',
  '50% done',
  '100%',
  '%s',
  '%%',
  '%d and %s',
  '$a',
  0,
  -0,
  1.5,
  1e21,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  10n,
  -12345678901234567890n,
  true,
  null,
  undefined,
  Symbol('sym'),
  () => {},
  new Point(),
  new Date(0),
  new Date(Number.NaN),
  /re+/gi,
  new Map([[1, 'a']]),
  new Set([1, 2]),
  [],
  [1, 2, 3],
  ['a', ['b', ['c']]],
  [-0, Number.NaN],
  {},
  { a: 1 },
  { a: { b: { c: { d: 1 } } } },
  cyclic,
  [cyclic],
]

/** Titles that cover every token, an escape, a stray % and the variables. */
const arrayTitles: readonly string[] = [
  'plain',
  '%p',
  '%s',
  '%d',
  '%i',
  '%f',
  '%j',
  '%o',
  '%O',
  '%c',
  '%#',
  '%$',
  '%%',
  '[%p|%s|%d]',
  '%s %s %s',
  '%# %# %$ %$',
  '%%s %s',
  '%%%s',
  '%%# %#',
  '%%$ %$',
  '100% sure %s',
  '% d %s',
  'trailing %',
  '%x %e %5d %s',
  '$a %s',
  '$# $0 %s',
  '%c %s %s',
  '%p and %j',
]

test('a table of arrays titles every token as jest-each does, over every kind of value', () => {
  for (const title of arrayTitles) {
    // One cell per row, then three cells, so a title has fewer, as many and more values than tokens.
    for (const shape of [(v: unknown) => [v], (v: unknown) => [v, 'two', 3]]) {
      const table = values.map(shape)
      assert.deepEqual(ourTitles(title, table), jestTitles(title, table), JSON.stringify(title))
    }
  }
})

test('a table of bare values titles each as a one-item row', () => {
  for (const title of arrayTitles) {
    const table = values.filter((v) => typeof v !== 'object' || v === null)
    if (table.length === 0) continue
    assert.deepEqual(ourTitles(title, table), jestTitles(title, table), JSON.stringify(title))
  }
})

test('a table of objects is read as templates: $variables, then %% as %', () => {
  const table = [
    { a: 1, b: 'two', c: { d: 3 } },
    { a: 'x', b: null, c: { d: [1, 2] } },
    { a: undefined, b: true, c: 'plain' },
    { a: { nested: { deep: { deeper: 1 } } }, b: [1, [2, [3]]], c: { d: { e: { f: 1 } } } },
    { a: '50% off', b: '%s', c: '$a' },
    { ab: 1, a: 2, 'a.b': 3, 'a b': 4, 'a+b': 5, '': 6, $x: 7 },
  ]
  const titles = [
    'plain',
    'a=$a',
    'b=$b c.d=$c.d',
    '$a|$b|$c',
    'c.d.e.f=$c.d.e.f',
    'missing=$zz and $a.zz and $c.zz.yy',
    '$# $a',
    '$a$b$c',
    '$a. $b.',
    '$',
    '$$a',
    '$a.b $ab $a+b $a b $x $$x',
    '%% $a',
    '$a %% %%',
    '100%% $b',
    '%%s $a',
    '$a %',
    '$a %x',
  ]
  for (const title of titles) {
    assert.deepEqual(ourTitles(title, table), jestTitles(title, table), JSON.stringify(title))
  }
})

test('an object row beside a % token is one value for the tokens, and $variables stay', () => {
  const table = [{ a: 1 }, { a: 'x', b: { c: 2 } }]
  for (const title of ['%s $a', '%# $a', '%$ $a', '%p|%j|$a', '%s %s', '%o|%O']) {
    assert.deepEqual(ourTitles(title, table), jestTitles(title, table), JSON.stringify(title))
  }
})

/** The rows of a tagged template, the way core builds them: one object per row, keyed by heading. */
function templateRows(headings: readonly string[], cells: readonly unknown[]) {
  const rows: Array<Record<string, unknown>> = []
  for (let start = 0; start < cells.length; start += headings.length) {
    rows.push(Object.fromEntries(headings.map((h, i) => [h, cells[start + i]])))
  }
  return rows
}

test('a tagged template reads its title for $variables only, as jest-each does', () => {
  const cells = [1, 2, 'x', null, { k: 'v' }, [1, 2], '50% off', '%s', true, undefined, 10n, -0]
  const rows = templateRows(['a', 'b'], cells)
  const run = (title: string): string[] => {
    const tag = (strings: TemplateStringsArray, ...data: unknown[]): string[] =>
      jestTitles(title, strings, ...data)
    return tag`
      a | b
      ${cells[0]} | ${cells[1]}
      ${cells[2]} | ${cells[3]}
      ${cells[4]} | ${cells[5]}
      ${cells[6]} | ${cells[7]}
      ${cells[8]} | ${cells[9]}
      ${cells[10]} | ${cells[11]}
    `
  }
  for (const title of [
    'plain',
    '$a + $b',
    '$# $a',
    '$a.k $b.0 $b.nope',
    '%s $a',
    '%# $a',
    '%$ $a',
    '%% $a',
    '$a %% $b',
    '%%s $a',
    '100% $a',
    '%p|%j $a',
    '$',
  ]) {
    const expected = run(title)
    assert.equal(expected.length, rows.length)
    const ours = rows.map((row, index) => formatEachTitle(title, row, index, 'template'))
    assert.deepEqual(ours, expected, JSON.stringify(title))
  }
})

test('without the table kind, a row of objects is read as an array of objects', () => {
  // The same % in the title of an array of objects and of a template: jest-each turns %% into %
  // for the first and leaves it for the second.
  const row = { a: 1 }
  assert.equal(formatEachTitle('100%% $a', row, 0), '100% 1')
  assert.equal(formatEachTitle('100%% $a', row, 0, 'rows'), '100% 1')
  assert.equal(formatEachTitle('100%% $a', row, 0, 'template'), '100%% 1')
})

test('%j prints a bigint as a quoted literal and a cycle as [Circular], where util.format throws', () => {
  assert.equal(formatEachTitle('%j', [5n], 0), '"5n"')
  assert.equal(formatEachTitle('%j', [{ big: 5n }], 0), '{"big":"5n"}')
  assert.equal(formatEachTitle('%j', [cyclic], 0), '[Circular]')
})

test('a title that holds a token twice replaces the first %# and %$ only, as jest-each does', () => {
  // The second %# is a token with a value left, which util.format does not know: it appends it.
  assert.equal(formatEachTitle('%# %# %$ %$', [1], 3), '3 %# 4 %$ 1')
})

test('the dialect`s core.formatEachTitle is this function, loaded through the behaviour loader', async () => {
  const ref = resolvePolicy(jestPolicy).core.formatEachTitle
  const loaded: FormatEachTitle = await createBehaviourLoader().load(ref)
  assert.equal(loaded, formatEachTitle)
  assert.equal(loaded('%s-%d', ['a', 2], 0), 'a-2')
})

test('the same title reads the same, whatever ran before it', () => {
  // Upstream tests a global regex in place, and a match leaves `lastIndex` behind for the next
  // table's check (UPSTREAM.md, "Not reproduced"). Ours carries nothing from title to title.
  const row = { a: 1 }
  for (const first of ['xxxxxxxx %s', '%s', '$a']) {
    formatEachTitle(first, row, 0)
    assert.equal(formatEachTitle('%s', row, 0), '{ a: 1 }')
    assert.equal(formatEachTitle('$a', row, 0), '1')
  }
})
