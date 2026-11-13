// T9.6's Done-when: the rebuilt schedule simulation (Track 9 §Spikes C) lands within +-1% of the
// spike's ratios. The model is `schedule-sim.ts`; the sequencer it feeds is the real one, so these
// are the numbers of the code that ships. 40 seeded trials, as the spike ran.
//
// Tolerance: a ratio must be within 1% of the spike's (1.118 means 1.107 to 1.129); a share of files
// moved within 1 percentage point. What reproduced and what did not is in `docs/plan/bundles/B21.md`:
// the "worst of 40" values are one random draw each (the spike's seeds are gone), so they are not
// asserted to 1%; only that the contiguous cuts' worst case stays under the sha1 split's. The
// contiguous cuts' churn (2.8% in the spike) is a `todo`: the spike's text does not say where the
// new files sort, and the two readings give 0.3% and 3.2%.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  generateFiles,
  median,
  movedShare,
  orderRatio,
  seededRandom,
  shardRatio,
} from './schedule-sim.ts'

const TRIALS = 40
const SEED = 1000

/** The spike's figures this checks (Track 9 §Spikes C, and the research table "Sharding"). */
const SPIKE = {
  jestOrder150: 1.002,
  jestOrder1000: 1.0,
  sha1Median: 1.118,
  contiguousMedian: 1.062,
  sha1Moved: 0.007,
  contiguousMoved: 0.028,
} as const

function within(measured: number, target: number, relative: number): boolean {
  return Math.abs(measured - target) <= target * relative
}

/** Every trial's measurements, computed once. */
const trials = Array.from({ length: TRIALS }, (_, trial) => {
  const random = seededRandom(SEED + trial)
  const files150 = generateFiles(150, random)
  const files1000 = generateFiles(1000, random)
  const extra = generateFiles(50, random)
  return {
    jest150: orderRatio(files150, 'history', 8),
    jest1000: orderRatio(files1000, 'history', 8),
    alphabetical150: orderRatio(files150, 'alphabetical', 8),
    oracle150: orderRatio(files150, 'oracle', 8),
    sha1: shardRatio(files1000, 4, 2, 'sha1'),
    contiguous: shardRatio(files1000, 4, 2, 'contiguous'),
    sha1Moved: movedShare(files1000, extra, 4, 'sha1'),
    contiguousMoved: movedShare(files1000, extra, 4, 'contiguous'),
  }
})
const column = (key: keyof (typeof trials)[number]): number[] => trials.map((t) => t[key])

describe('schedule simulation (40 seeded trials)', () => {
  it('file order: Jest order is +0.2% over the LPT bound at 150 files, and at the bound at 1,000', () => {
    const jest150 = median(column('jest150'))
    assert.ok(
      jest150 >= 1 && jest150 - SPIKE.jestOrder150 <= 0.01 && SPIKE.jestOrder150 - jest150 <= 0.01,
      `Jest order, 150 files: ${jest150.toFixed(4)} (spike ${SPIKE.jestOrder150})`,
    )
    const jest1000 = median(column('jest1000'))
    assert.ok(
      jest1000 >= 1 && jest1000 - SPIKE.jestOrder1000 <= 0.01,
      `Jest order, 1,000 files: ${jest1000.toFixed(4)} (spike ${SPIKE.jestOrder1000})`,
    )
  })

  it('file order: alphabetical is far worse than Jest order, and the oracle is at the bound', () => {
    assert.ok(median(column('alphabetical150')) > 1.15, 'alphabetical order wastes workers')
    assert.ok(median(column('oracle150')) < 1.01)
    assert.ok(median(column('jest150')) < median(column('alphabetical150')))
  })

  it('sharding: the sha1 split ends its slowest shard +11.8% over ideal (median)', () => {
    const measured = median(column('sha1'))
    assert.ok(
      within(measured, SPIKE.sha1Median, 0.01),
      `sha1 slice: ${measured.toFixed(4)} (spike ${SPIKE.sha1Median}, within 1%)`,
    )
  })

  it('sharding: contiguous cuts by time end it +6.2% over ideal (median)', () => {
    const measured = median(column('contiguous'))
    assert.ok(
      within(measured, SPIKE.contiguousMedian, 0.01),
      `contiguous cuts: ${measured.toFixed(4)} (spike ${SPIKE.contiguousMedian}, within 1%)`,
    )
  })

  it('sharding: the worst of 40 is better for the contiguous cuts than for the sha1 split', () => {
    assert.ok(Math.max(...column('contiguous')) < Math.max(...column('sha1')))
  })

  it('churn: the sha1 split moves 0.7% of the files when 5% more appear', () => {
    const measured = median(column('sha1Moved'))
    assert.ok(
      Math.abs(measured - SPIKE.sha1Moved) <= 0.01,
      `sha1 moved: ${(100 * measured).toFixed(2)}% (spike 0.7%, within 1 point)`,
    )
  })

  it('churn: the contiguous cuts move 2.8% of the files when 5% more appear (not reproduced: see the header)', {
    todo: 'the spike does not say where the new files sort; 0.3% (random paths) or 3.2% (sorted last)',
  }, () => {
    const measured = median(column('contiguousMoved'))
    assert.ok(
      Math.abs(measured - SPIKE.contiguousMoved) <= 0.01,
      `contiguous moved: ${(100 * measured).toFixed(2)}% (spike 2.8%, within 1 point)`,
    )
  })
})
