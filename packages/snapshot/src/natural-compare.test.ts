import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, test } from 'node:test'
import { naturalCompare } from './vendor/natural-compare.ts'

// The original package, as the oracle: the vendored port must order every pair the same way.
const oracle: (a: string, b: string) => number = createRequire(import.meta.url)('natural-compare')

describe('naturalCompare', () => {
  test('orders numbers inside strings as numbers', () => {
    const keys = ['numbers 10', 'numbers 2', 'numbers 1', 'a 11', 'a 9']
    assert.deepEqual(keys.sort(naturalCompare), [
      'a 9',
      'a 11',
      'numbers 1',
      'numbers 2',
      'numbers 10',
    ])
  })

  test('is 0 for equal strings and antisymmetric', () => {
    assert.equal(naturalCompare('x 1', 'x 1'), 0)
    assert.equal(naturalCompare('a', 'b'), -naturalCompare('b', 'a'))
  })

  test('agrees with the original on a seeded set of snapshot-like keys', () => {
    let seed = 12345
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed
    }
    const parts = [
      'outer',
      'inner',
      'each',
      'hint',
      'Ünï',
      '-',
      ' > ',
      ': ',
      '0',
      '7',
      '10',
      '100',
      'é',
    ]
    const make = (): string => {
      let text = ''
      for (let i = 0, n = 1 + (next() % 6); i < n; i++) text += parts[next() % parts.length]
      return `${text} ${1 + (next() % 12)}`
    }
    for (let i = 0; i < 4000; i++) {
      const a = make()
      const b = make()
      assert.equal(Math.sign(naturalCompare(a, b)), Math.sign(oracle(a, b)), `${a} vs ${b}`)
    }
  })
})
