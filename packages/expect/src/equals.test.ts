// The vendored `equals` and its testers against the real @jest/expect-utils 30.5.2 (the oracle,
// a devDependency), over a seeded table of value pairs: same answer for every pair and every set of
// testers, in both modes.
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import * as upstream from '@jest/expect-utils'
import { describe, test } from 'provino'
import * as vendored from './vendor/expect-utils/index.ts'

/** A small seeded generator (mulberry32), so the table is the same on every run. */
function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeValue(random: () => number, depth: number): unknown {
  const pick = Math.floor(random() * (depth > 2 ? 9 : 16))
  switch (pick) {
    case 0:
      return Math.floor(random() * 3)
    case 1:
      return ['a', 'b', ''][Math.floor(random() * 3)]
    case 2:
      return [undefined, null, Number.NaN, 0, -0][Math.floor(random() * 5)]
    case 3:
      return random() < 0.5
    case 4:
      return 10n ** BigInt(Math.floor(random() * 2))
    case 5:
      return new Date(Math.floor(random() * 2) * 1000)
    case 6:
      return random() < 0.5 ? Symbol.for('x') : /re/g
    case 7:
      return new Error(['m', 'n'][Math.floor(random() * 2)])
    case 8:
      return Symbol.for(['s', 't'][Math.floor(random() * 2)] as string)
    case 9:
    case 10: {
      const length = Math.floor(random() * 3)
      return Array.from({ length }, () => makeValue(random, depth + 1))
    }
    case 11: {
      const sparse: unknown[] = new Array(2)
      if (random() < 0.5) sparse[1] = makeValue(random, depth + 1)
      return sparse
    }
    case 12:
      return new Set([makeValue(random, depth + 1)])
    case 13:
      return new Map([[makeValue(random, depth + 1), makeValue(random, depth + 1)]])
    case 14:
      return new Uint8Array([Math.floor(random() * 2)])
    default: {
      const object: Record<string, unknown> = {}
      for (const key of ['a', 'b']) {
        if (random() < 0.7) object[key] = makeValue(random, depth + 1)
      }
      return random() < 0.2 ? Object.assign(Object.create(null), object) : object
    }
  }
}

const sets = (lib: typeof upstream | typeof vendored) => ({
  none: [] as never[],
  equal: [lib.iterableEquality],
  subset: [lib.iterableEquality, lib.subsetEquality],
  strict: [
    lib.iterableEquality,
    lib.typeEquality,
    lib.sparseArrayEquality,
    lib.arrayBufferEquality,
  ],
})

const MATCHER = Symbol.for('jest.asymmetricMatcher')
const isOne = {
  $typeof: MATCHER,
  asymmetricMatch: (other: unknown) => other === 1,
  toString: () => 'One',
}

function cycle(): Record<string, unknown> {
  const a: Record<string, unknown> = { n: 1 }
  a.self = a
  return a
}
function cyclicSet(): Set<unknown> {
  const s = new Set<unknown>()
  s.add(s)
  return s
}
function cyclicMap(): Map<unknown, unknown> {
  const m = new Map<unknown, unknown>()
  m.set('me', m)
  return m
}
class Point {
  x = 1
}
class Other {
  x = 1
}
const hidden = Object.defineProperty({ a: 1 }, 'h', { value: 1, enumerable: false })
const hiddenToo = Object.defineProperty({ a: 1 }, 'h', { value: 2, enumerable: false })
const sym = Symbol('k')
function sparse(): unknown[] {
  const items: unknown[] = [1]
  items[2] = 3
  return items
}
const foreign = <T>(source: string): T => runInNewContext(source) as T

/** Pairs worth fixing by hand: each one a place a one-line change to the copy shows. */
const fixed: readonly [name: string, a: unknown, b: unknown][] = [
  ['asymmetric on the left', isOne, 1],
  ['asymmetric on the right', 1, isOne],
  ['asymmetric that fails', isOne, 2],
  ['asymmetric inside an object', { a: isOne }, { a: 1 }],
  ['asymmetric inside an array', [isOne], [1]],
  ['self-referencing objects', cycle(), cycle()],
  ['self-referencing against a plain object', cycle(), { n: 1 }],
  ['self-referencing sets', cyclicSet(), cyclicSet()],
  ['self-referencing maps', cyclicMap(), cyclicMap()],
  ['array from another realm', foreign('[1, 2]'), [1, 2]],
  ['array against another realm array', foreign('[1, 2]'), foreign('[1, 2]')],
  ['Map from another realm', foreign('new Map([[1, 2]])'), new Map([[1, 2]])],
  ['Set from another realm', foreign('new Set([1])'), new Set([1])],
  ['Date from another realm', foreign('new Date(5)'), new Date(5)],
  ['Date from another realm, other time', foreign('new Date(5)'), new Date(6)],
  ['object from another realm', foreign('({ a: 1 })'), { a: 1 }],
  ['class instance from another realm', foreign('new (class A { x = 1 })()'), new Point()],
  ['two instances of one class', new Point(), new Point()],
  ['two classes with the same shape', new Point(), new Other()],
  ['a class instance against a plain object', new Point(), { x: 1 }],
  ['symbol keys equal', { [sym]: 1 }, { [sym]: 1 }],
  ['symbol keys differ', { [sym]: 1 }, { [sym]: 2 }],
  ['symbol key against none', { [sym]: 1 }, {}],
  ['non-enumerable property, equal', hidden, { a: 1 }],
  ['non-enumerable property, differing', hidden, hiddenToo],
  ['TypeError against Error, same message', new TypeError('m'), new Error('m')],
  ['Error against Error, other message', new Error('m'), new Error('n')],
  ['Error with a cause', new Error('m', { cause: 1 }), new Error('m', { cause: 2 })],
  ['URLs equal', new URL('http://a.test/x'), new URL('http://a.test/x')],
  ['URLs differ', new URL('http://a.test/x'), new URL('http://a.test/y')],
  ['an invalid Date against itself', new Date(Number.NaN), new Date(Number.NaN)],
  ['an invalid Date against a Date', new Date(Number.NaN), new Date(0)],
  ['ArrayBuffers equal', new Uint8Array([1, 2]).buffer, new Uint8Array([1, 2]).buffer],
  ['ArrayBuffers differ', new Uint8Array([1, 2]).buffer, new Uint8Array([1, 3]).buffer],
  [
    'DataViews equal',
    new DataView(new Uint8Array([1, 2]).buffer),
    new DataView(new Uint8Array([1, 2]).buffer),
  ],
  [
    'DataViews differ',
    new DataView(new Uint8Array([1, 2]).buffer),
    new DataView(new Uint8Array([2, 2]).buffer),
  ],
  ['undefined property against none', { a: undefined }, {}],
  ['undefined property against another', { a: undefined }, { b: undefined }],
  ['0 against -0', 0, -0],
  ['NaN against NaN', Number.NaN, Number.NaN],
  ['boxed primitives', new Number(1), new Number(1)],
  ['a boxed primitive against a primitive', new String('a'), 'a'],
  ['regular expressions', /a/g, /a/g],
  ['regular expressions with other flags', /a/g, /a/i],
  ['sets of objects', new Set([{ a: 1 }]), new Set([{ a: 1 }])],
  ['maps with object keys', new Map([[{ a: 1 }, 1]]), new Map([[{ a: 1 }, 1]])],
  ['arrays with extra keys', Object.assign([1], { k: 1 }), [1]],
  ['sparse against dense', sparse(), [1, undefined, 3]],
  ['an array against an object with its keys', [1, 2], { 0: 1, 1: 2 }],
]

/** A tester that asks `this.equals`, as a user's does. */
function lowercase(this: { equals: (a: unknown, b: unknown) => boolean }, a: unknown, b: unknown) {
  if (typeof a === 'string' && typeof b === 'string')
    return this.equals(a.toLowerCase(), b.toLowerCase())
  return undefined
}

describe('the vendored @jest/expect-utils', () => {
  test('fixed pairs agree with the upstream under every tester set and both modes', () => {
    const mine = { ...sets(vendored), user: [lowercase] }
    const theirs = { ...sets(upstream), user: [lowercase] }
    for (const [name, a, b] of fixed) {
      for (const [x, y] of [
        [a, b],
        [b, a],
      ] as const) {
        for (const set of Object.keys(mine) as (keyof typeof mine)[]) {
          for (const strict of [false, true]) {
            assert.equal(
              vendored.equals(x, y, mine[set] as never, strict),
              upstream.equals(x, y, theirs[set] as never, strict),
              `${name}, ${set}, strict=${strict}`,
            )
          }
        }
      }
    }
  })

  test('a user tester that calls this.equals is used the same way', () => {
    assert.equal(vendored.equals({ a: 'X' }, { a: 'x' }, [lowercase]), true)
    assert.equal(upstream.equals({ a: 'X' }, { a: 'x' }, [lowercase]), true)
    assert.equal(vendored.equals({ a: 'X' }, { a: 'y' }, [lowercase]), false)
  })

  test('the testers agree on the fixed pairs', () => {
    type Tester = (x: unknown, y: unknown) => unknown
    const testers: readonly [string, Tester, Tester][] = [
      [
        'iterableEquality',
        vendored.iterableEquality as Tester,
        upstream.iterableEquality as Tester,
      ],
      ['subsetEquality', vendored.subsetEquality as Tester, upstream.subsetEquality as Tester],
      ['typeEquality', vendored.typeEquality as Tester, upstream.typeEquality as Tester],
      [
        'sparseArrayEquality',
        vendored.sparseArrayEquality as Tester,
        upstream.sparseArrayEquality as Tester,
      ],
      [
        'arrayBufferEquality',
        vendored.arrayBufferEquality as Tester,
        upstream.arrayBufferEquality as Tester,
      ],
    ]
    for (const [name, a, b] of fixed) {
      for (const [tester, mine, theirs] of testers) {
        assert.deepEqual(mine(a, b), theirs(a, b), `${name}, ${tester}`)
      }
    }
  })

  test('equals and every tester agree with the upstream on a seeded table of pairs', () => {
    const random = seeded(30_5_2)
    const mine = sets(vendored)
    const theirs = sets(upstream)
    let pairs = 0
    for (let index = 0; index < 1500; index++) {
      const a = makeValue(random, 0)
      // A pair is either two draws or a value and a copy of its own shape.
      const b = random() < 0.4 ? structuredCloneOr(a) : makeValue(random, 0)
      for (const name of ['none', 'equal', 'subset', 'strict'] as const) {
        for (const strict of [false, true]) {
          assert.equal(
            vendored.equals(a, b, mine[name] as never, strict),
            upstream.equals(a, b, theirs[name] as never, strict),
            `${name} strict=${strict} pair ${index}`,
          )
          pairs++
        }
      }
    }
    assert.ok(pairs >= 12000)
  })

  test('getPath, isA and the exported names match the upstream', () => {
    assert.deepEqual(Object.keys(vendored).sort(), Object.keys(upstream).sort())
    const object = { a: { b: [{ c: 1 }] } }
    for (const path of ['a.b[0].c', 'a.x', ['a', 'b', '0'], 'a.b.length']) {
      assert.deepEqual(
        vendored.getPath(object, path as string),
        upstream.getPath(object, path as string),
      )
    }
    const fnWithUndefined = Object.assign(() => {}, { own: undefined })
    for (const [target, path] of [
      ['abc', 'length'],
      [fnWithUndefined, 'own'],
      [fnWithUndefined, 'other'],
      [null, 'a'],
      [undefined, 'a'],
      [{ a: undefined }, 'a'],
      [[1, 2], '1'],
      [[1, 2], [1]],
    ] as const) {
      const run = (lib: typeof upstream | typeof vendored): unknown => {
        try {
          return lib.getPath(target as Record<string, unknown>, path as string)
        } catch (error) {
          return { threw: (error as Error).constructor.name }
        }
      }
      assert.deepEqual(run(vendored), run(upstream), `${String(target)}, ${String(path)}`)
    }
    assert.equal(vendored.isA('Array', []), upstream.isA('Array', []))
  })
})

function structuredCloneOr(value: unknown): unknown {
  try {
    return structuredClone(value)
  } catch {
    return value
  }
}
