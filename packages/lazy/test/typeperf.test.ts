// T6.3: sixty chained `.let`s, three overrides and sixty reads compile with no error and within 150,000
// type instantiations on TS 7.0.2 and 5.9.3.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { COMPILERS } from './support/tsc.ts'
import {
  budgetProblems,
  DEFAULT_LETS,
  generateChain,
  measure,
  parseInstantiations,
} from './support/typeperf.ts'

describe('type performance of a chain', () => {
  for (const compiler of COMPILERS) {
    test(`${DEFAULT_LETS} chained lets on ${compiler}`, () => {
      assert.deepEqual(budgetProblems(measure(compiler, DEFAULT_LETS)), [])
    })
  }

  test('a planted limit of 1,000 fails', () => {
    const problems = budgetProblems(measure('typescript', DEFAULT_LETS), 1_000)
    assert.equal(problems.length, 1)
    assert.match(problems[0] ?? '', /instantiations at 60 lets is over 1000/)
  })

  test('the count is read from the compiler output, and its absence is an error', () => {
    assert.equal(
      parseInstantiations('Types:   12\nInstantiations:   61789\nMemory used: 1K\n'),
      61_789,
    )
    assert.equal(parseInstantiations('Types: 12\n'), undefined)
  })

  test('the generated chain has one definition and one read per key', () => {
    const source = generateChain(5)
    assert.equal(source.match(/\.let\(/g)?.length, 5)
    assert.equal(source.match(/\.override\(/g)?.length, 3)
    assert.equal(source.match(/^export const r\d+/gm)?.length, 5)
  })
})
