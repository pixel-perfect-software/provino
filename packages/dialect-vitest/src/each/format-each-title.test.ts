// T5.4: Vitest's `.each` titles. Vitest 5.0 does not export `formatTitle` (it lives in the runner,
// inside the `vitest` package), so the title function is held to Vitest's recorded titles, by the
// runtime corpus (`@provino/harness`, `fixtures/runtime/each-*`, about 2,400 titles) and by the
// expectations below, each one a title from those goldens. The `format` and `inspect` it calls
// come from `@vitest/utils`, which is installed, so those are compared in-process.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createBehaviourLoader, resolvePolicy } from '@provino/policy'
import type { FormatEachTitle } from '@provino/types'
import { vitestPolicy } from '../dialect.ts'
import { formatEachTitle } from './format-each-title.ts'
import { VITEST_EACH_TITLE_TRUNCATE } from './title-truncate.ts'
import * as ours from './vendor/utils/display.ts'

interface Display {
  format(args: unknown[], options?: object): string
  inspect(value: unknown, options?: object): string
}

// @vitest/utils is a dependency of vitest: resolve it from there.
const vitestEntry = fileURLToPath(import.meta.resolve('vitest'))
const real = (await import(
  pathToFileURL(createRequire(vitestEntry).resolve('@vitest/utils/display')).href
)) as Display

class Point {
  x = 1
  y = 2
}
const cyclic: Record<string, unknown> = { name: 'cyclic' }
cyclic.self = cyclic
const noStack = new Error('boom')
delete noStack.stack

const values: readonly unknown[] = [
  'text',
  '',
  "it's",
  'two\nlines',
  'x'.repeat(100),
  `${'x'.repeat(38)}\u{1F389}${'y'.repeat(20)}`,
  0,
  -0,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  10n,
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
  Array.from({ length: 50 }, (_, index) => index),
  {},
  { a: 1 },
  { a: { b: { c: { d: 1 } } } },
  Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`key${index}`, index])),
  cyclic,
  noStack,
  Object.create(null),
  new Uint8Array([1, 2, 3]),
  new Proxy({ proxied: true }, {}),
  { toString: () => 'own toString' },
]

test('the vendored inspect prints a value as @vitest/utils does, with and without a cut', () => {
  for (const value of values) {
    for (const options of [undefined, { truncate: 40 }, { truncate: 10 }, { multiline: true }]) {
      assert.equal(ours.inspect(value, options), real.inspect(value, options), String(options))
    }
  }
})

test('the vendored format prints every token as @vitest/utils does', () => {
  const templates = ['%s', '%d', '%i', '%f', '%o', '%O', '%c', '%j', '%%', '%p', '%x', '[%s|%s]']
  for (const template of templates) {
    for (const value of values) {
      // `%d`, `%i` and `%f` throw on a null-prototype object, `%j` on a bigint: in both.
      const run = (display: Display): string | { threw: string } => {
        try {
          return display.format([template, value, 'second'], { truncate: 40 })
        } catch (error) {
          return { threw: error instanceof Error ? error.constructor.name : String(error) }
        }
      }
      assert.deepEqual(run(ours), run(real), `${template} ${Object.prototype.toString.call(value)}`)
    }
  }
  assert.equal(ours.format(['no template', 1, 'x']), real.format(['no template', 1, 'x']))
  assert.equal(ours.format([1, { a: 1 }]), real.format([1, { a: 1 }]))
})

// Each title below is from a recorded Vitest 5.0.5 golden (`fixtures/runtime/each-*`).
const recorded: ReadonlyArray<
  readonly [
    template: string,
    row: readonly unknown[] | Readonly<Record<string, unknown>>,
    index: number,
    title: string,
  ]
> = [
  ['p[%p]', ['text'], 0, 'p[%p]'],
  ['s[%s]', ['50% done'], 0, 's[50% done]'],
  ['s[%s]', [{ a: 1 }], 0, 's[{ a: 1 }]'],
  ['s[%s]', [[1, 2, 3]], 0, 's[1,2,3]'],
  ['s[%s]', [new Map([[1, 'a']])], 0, "s[Map { 1 => 'a' }]"],
  ['s[%s]', [-0], 0, 's[-0]'],
  ['s[%s]', [10n], 0, 's[10n]'],
  ['d[%d]', ['12abc'], 0, 'd[NaN]'],
  ['%i %i %i %i %i', ['12abc', '1e3', '', ' 7 ', 'abc'], 0, '12 1 NaN 7 NaN'],
  ['f[%f]', [-0], 0, 'f[-0]'],
  ['f[%f]', [Number.NaN], 0, 'f[NaN]'],
  ['o[%o]', [1.5], 0, 'o[1.5]'],
  ['O[%O]', ['text'], 0, "O['text']"],
  ['c[%c]', [1], 0, 'c[]'],
  ['c2[%c %s]', ['x'], 0, 'c2[ undefined]'],
  ['idx[%#] num[%$]', [1], 18, 'idx[18] num[19]'],
  ['pct[%%]', [0.1 + 0.2], 0, 'pct[% 0.30000000000000004]'],
  ['pct2[%% %s %%]', [Number.POSITIVE_INFINITY], 0, 'pct2[% Infinity undefined % undefined]'],
  ['three s: %s %s %s', [1], 0, 'three s: 1 undefined undefined'],
  ['empty row: %s|%d|%j|%p|%o|%#', [], 0, 'empty row: undefined|NaN|undefined|%p|undefined|0'],
  ['%# %# %$ %$', [1], 0, '0 0 1 1'],
  ['%%s %s', [1, 2], 0, '% 1s 2'],
  ['%%%s', [1, 2], 0, '% 12'],
  ['100% sure %s', [1], 0, '100% sure 1'],
  ['%p %s', ['a%sb', 'c'], 0, '%p a%sb'],
  ['%d %s %j %p %f', [1, 'two', { three: 3 }, [4], 5.5], 0, '1 two {"three":3} %p 4'],
  ['%p %j %s %d %i', [1, 'two', { three: 3 }, [4], 5.5], 0, '%p 1 two NaN 4'],
  ['b=$b c.d=$c.d', { a: 1, b: 'two', c: { d: 3 } }, 0, 'b=two c.d=3'],
  ['$a, $b; ($c)', { a: 1, b: 'two', c: { d: 3 } }, 0, '1, two; ({ d: 3 })'],
  [
    'missing=$zz and $a.zz and $c.zz.yy',
    { a: 1, b: 'two', c: { d: 3 } },
    0,
    'missing=undefined and undefined and undefined',
  ],
  ['$0|$1|$a|$#|%s', [{ a: 'x' }, 'y'], 0, "{ a: 'x' }|y|x|$#|{ a: 'x' }"],
  ['$0|$1|$a|$#|%s', [1, 'b'], 0, '1|b|$a|$#|1'],
  [
    '$a $b.c $0 $1 %p',
    [{ a: 'x', b: { c: 'y' } }, 'second'],
    0,
    "x y { a: 'x', b: { c: 'y' } } second %p",
  ],
  ['%s $a', { a: 1, b: 'two', c: { d: 3 } }, 0, "{ a: 1, b: 'two', c: { d: 3 } } 1"],
  ['$a %%', { a: 1, b: 'two', c: { d: 3 } }, 0, "1 % { a: 1, b: 'two', c: { d: 3 } }"],
]

test('formatEachTitle gives the titles Vitest 5.0.5 recorded', () => {
  for (const [template, row, index, title] of recorded) {
    assert.equal(formatEachTitle(template, row, index), title, template)
  }
})

test('a value is cut to 40 characters: a string ends in an ellipsis, an object shrinks to fit', () => {
  const long = 'x'.repeat(100)
  assert.equal(formatEachTitle('$s', { s: long }, 0), `${'x'.repeat(39)}…`)
  assert.equal(formatEachTitle('$s', { s: 'x'.repeat(40) }, 0), 'x'.repeat(40))
  // %s prints a string as it is, and %j is not cut: only what `inspect` prints is.
  assert.equal(formatEachTitle('%s', [long], 0), long)
  assert.equal(formatEachTitle('%j', [[long]], 0), `["${long}"]`)
  assert.equal(formatEachTitle('%o', [long], 0), `'${'x'.repeat(38)}…'`)
  assert.equal(formatEachTitle('$o', { o: { list: long, more: 1 } }, 0).length <= 40, true)
  // A cut never splits a surrogate pair.
  assert.equal(
    formatEachTitle('$s', { s: `${'x'.repeat(38)}\u{1F389}${'y'.repeat(20)}` }, 0),
    `${'x'.repeat(38)}…`,
  )
})

test('the title is cut at the policy`s eachTitleTruncate: the formatter and the policy agree', () => {
  assert.equal(VITEST_EACH_TITLE_TRUNCATE, 40)
  assert.equal(resolvePolicy(vitestPolicy).core.eachTitleTruncate, VITEST_EACH_TITLE_TRUNCATE)
})

test('%j on a bigint throws, as Vitest`s format does: the file fails at collection', () => {
  assert.throws(() => formatEachTitle('%j', [5n], 0), TypeError)
})

test('%d, %i and %f on a null-prototype object throw, as Vitest`s format does', () => {
  for (const token of ['%d', '%i', '%f']) {
    assert.throws(() => formatEachTitle(token, [Object.create(null)], 0), TypeError, token)
  }
})

test('%p is not a Vitest token: it stays as written and takes no value', () => {
  assert.equal(formatEachTitle('%p %s', ['a', 'b'], 0), '%p a')
})

test('the dialect`s core.formatEachTitle is this function, loaded through the behaviour loader', async () => {
  const ref = resolvePolicy(vitestPolicy).core.formatEachTitle
  const loaded: FormatEachTitle = await createBehaviourLoader().load(ref)
  assert.equal(loaded, formatEachTitle)
  assert.equal(loaded('%s-%d', ['a', 2], 0), 'a-2')
})
