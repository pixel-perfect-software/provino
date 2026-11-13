import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { describeRun, type ImportSample, summarise } from './report.ts'

const sample = (entry: number, engine: number): ImportSample => ({
  entry,
  engine,
  total: entry + engine,
})

describe('summarise', () => {
  test('is the median of each part over the processes', () => {
    assert.deepEqual(summarise([sample(1, 30), sample(3, 10), sample(2, 50)]), {
      entry: 2,
      engine: 30,
      total: 31,
    })
  })
})

describe('describeRun', () => {
  const options = { processes: 15, node: 'v24.0.0' }

  test('prints the three numbers, labelled local, and passes with no bar', () => {
    const { lines, ok } = describeRun(sample(0.6, 30), { ...options, maxColdMs: undefined })
    assert.equal(ok, true)
    assert.match(lines[0] ?? '', /^expect import bench \(local, Node v24\.0\.0, 15 fresh processes/)
    assert.match(lines.join('\n'), /import \{ expect \} from 'provino'\s+0\.6 ms/)
    assert.match(lines.join('\n'), /total\s+30\.6 ms/)
  })

  test('holds a total at the bar and fails a total over it, on the total and not the entry', () => {
    assert.equal(describeRun(sample(0.5, 39.5), { ...options, maxColdMs: 40 }).ok, true)
    const miss = describeRun(sample(0.6, 51.4), { ...options, maxColdMs: 40 })
    assert.equal(miss.ok, false)
    assert.match(miss.lines.at(-1) ?? '', /^FAIL total is 52\.0 ms; the bar is ≤ 40 ms$/)
  })

  test('a total that rounds to the bar still reads as over it', () => {
    const { lines, ok } = describeRun(sample(0, 40.04), { ...options, maxColdMs: 40 })
    assert.equal(ok, false)
    assert.match(lines.at(-1) ?? '', /FAIL total is 40\.04 ms/)
  })

  test('a NaN total misses the bar instead of passing it', () => {
    assert.equal(describeRun(sample(0, Number.NaN), { ...options, maxColdMs: 40 }).ok, false)
  })
})
