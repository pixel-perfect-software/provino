// The vendored `equals` and its testers against the real @jest/expect-utils 30.5.2 (the oracle,
// a devDependency), over a seeded table of value pairs: same answer for every pair and every set of
// testers, in both modes.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import * as upstream from '@jest/expect-utils'
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
      return Number.isNaN(random()) ? Symbol.for('x') : /re/g
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

describe('the vendored @jest/expect-utils', () => {
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
