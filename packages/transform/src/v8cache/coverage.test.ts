// T3.7: why `cacheModeFor({ coverage: true })` is `'off'`. V8's precise coverage reports a function's
// block ranges only for a function compiled in this run; a script restored from a code cache has
// its functions already compiled, so what it reports is function-level only. Every measurement runs
// in a fresh child process (`runChild`), so V8's compilation state is clean, and each is of one
// script of 300 functions with a branch each, of which the top level calls 30.
//
// What the probe saw on Node 24.22, V8 13.6, `local` (5 runs each, identical every time): a plain
// compile reports 302 functions, 333 ranges, 32 of the functions with block coverage; the same
// script from a warm entry reports 302 functions, 302 ranges and none with block coverage. (The
// research's 229 against 542 are another script's numbers; the direction is the same.)
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { cacheModeFor } from './index.ts'
import { runChild, tempDir } from './test-helpers.ts'

const FUNCTIONS = 300
const RUNS = 5
const KEY = 'c0ffee0123456789'

const { dir, remove } = tempDir()
after(remove)

interface Counts {
  readonly functions: number
  readonly ranges: number
  readonly blockFunctions: number
  readonly stats: { readonly hits: number; readonly misses: number; readonly written: number }
  readonly cachedDataRejected: boolean | null
}
function measure(how: 'plain' | 'cache', mode: 'on' | 'off'): Counts {
  return runChild('coverage', { dir, key: KEY, functions: FUNCTIONS, how, mode }) as Counts
}
const shape = (counts: Counts): object => ({
  functions: counts.functions,
  ranges: counts.ranges,
  blockFunctions: counts.blockFunctions,
})

test('cacheModeFor: off when coverage is on, on otherwise', () => {
  assert.equal(cacheModeFor({ coverage: true }), 'off')
  assert.equal(cacheModeFor({ coverage: false }), 'on')
})

test('with coverage on, the cache mode leaves the script to compile as it does with no cache at all', () => {
  // A warm entry, made by a run with the cache on and no coverage.
  const warm = runChild('load', { dir, key: KEY, functions: FUNCTIONS }) as {
    readonly stats: { readonly written: number }
  }
  assert.equal(warm.stats.written, 1)

  const coverageMode = cacheModeFor({ coverage: true })
  for (let run = 0; run < RUNS; run++) {
    const plain = measure('plain', 'on')
    const off = measure('cache', coverageMode)
    // The measurement isn't vacuous: a plain compile reports block ranges.
    assert.ok(plain.blockFunctions > 0, 'a plain compile has block coverage')
    assert.ok(plain.ranges > plain.functions, 'a plain compile has ranges inside functions')
    // The switch: nothing read, nothing written, and the same counts as with no cache.
    assert.deepEqual(off.stats, { hits: 0, misses: 0, rejected: 0, written: 0, writeFailures: 0 })
    assert.equal(off.cachedDataRejected, null)
    assert.deepEqual(shape(off), shape(plain))
  }
})

test('the reason for the rule: with the cache on, a warm entry loses the block ranges coverage needs', () => {
  for (let run = 0; run < RUNS; run++) {
    const plain = measure('plain', 'on')
    const warm = measure('cache', 'on')
    assert.equal(warm.stats.hits, 1)
    assert.equal(warm.cachedDataRejected, false)
    // The same functions are there, but from the cache they carry no block ranges.
    assert.equal(warm.functions, plain.functions)
    assert.ok(
      warm.blockFunctions < plain.blockFunctions,
      `block coverage from the cache (${warm.blockFunctions}) is below a plain compile's (${plain.blockFunctions})`,
    )
    assert.ok(warm.ranges < plain.ranges)
  }
})
