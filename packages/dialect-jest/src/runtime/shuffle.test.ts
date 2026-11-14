// T5.13: `jestShuffle` is jest-circus's `shuffleArray`: pure-rand's xoroshiro128+ and a forward
// Fisher-Yates pass. Held to pure-rand's own pure API in-process, and to the order Jest 30.5.2 ran
// 30 tests in under `--randomize --seed=1234` (`cli/randomize-seed-flat`, `cli/randomize-seed-negative`).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { uniformIntDistribution, xoroshiro128plus } from 'pure-rand'
import { jestShuffle } from './shuffle.ts'

/** The same pass written against pure-rand's pure (non-mutating) API. */
function reference<T>(items: readonly T[], seed: number): T[] {
  const out = [...items]
  let rng = xoroshiro128plus(seed)
  for (let i = 0; i < out.length; i++) {
    const [n, next] = uniformIntDistribution(i, out.length - 1, rng)
    rng = next
    const value = out[i] as T
    out[i] = out[n] as T
    out[n] = value
  }
  return out
}

const numbers = (count: number): number[] => Array.from({ length: count }, (_, index) => index)

function golden(fixture: string): { titles: string[] } {
  const path = new URL(
    `../../../harness/fixtures/cli/${fixture}/__goldens__/jest.json`,
    import.meta.url,
  )
  const run = JSON.parse(readFileSync(path, 'utf8')) as {
    observed: { json: Record<string, { testResults: { assertionResults: { title: string }[] }[] }> }
  }
  const results = run.observed.json['.harness-out/jest.json']
  return { titles: (results?.testResults[0]?.assertionResults ?? []).map((test) => test.title) }
}

test('it gives what pure-rand gives for every seed and length', () => {
  for (const seed of [0, 1, 1234, -7, 2 ** 31 - 1, -(2 ** 31)]) {
    for (const length of [1, 2, 3, 10, 30, 101]) {
      assert.deepEqual(
        jestShuffle(seed)(numbers(length)),
        reference(numbers(length), seed),
        `${seed}/${length}`,
      )
    }
  }
})

test('it reorders the array it is given, in place, and returns it', () => {
  const items = numbers(10)
  const shuffled = jestShuffle(5)(items)
  assert.equal(shuffled, items)
  assert.notDeepEqual(items, numbers(10))
  assert.deepEqual(
    [...items].sort((a, b) => a - b),
    numbers(10),
  )
})

test('an empty array is returned as it is, drawing nothing', () => {
  const shuffle = jestShuffle(9)
  assert.deepEqual(shuffle([]), [])
  // The generator is untouched, so the next shuffle is the first of its seed.
  assert.deepEqual(shuffle(numbers(6)), jestShuffle(9)(numbers(6)))
})

test('one generator serves every call: two shuffles are not two of the first', () => {
  const shuffle = jestShuffle(1234)
  const first = shuffle(numbers(8))
  const second = shuffle(numbers(8))
  assert.deepEqual(first, jestShuffle(1234)(numbers(8)))
  assert.notDeepEqual(second, first)
})

test('a seed of 1234 runs 30 tests in the order Jest 30.5.2 did (cli/randomize-seed-flat)', () => {
  const { titles } = golden('randomize-seed-flat')
  assert.equal(titles.length, 30)
  assert.deepEqual(jestShuffle(1234)(titles.toSorted()), titles)
})
