// T9.6's Done-when: the rebuilt schedule simulation (Track 9 §Spikes C) lands within +-1% of the
// spike's ratios. The model is `schedule-sim.ts`; the sequencer it feeds is the real one, so these
// are the numbers of the code that ships. 40 seeded trials, as the spike ran.
//
// Tolerance: a ratio must be within 1% of the spike's (1.118 means 1.107 to 1.129); a share of files
// moved within 1 percentage point. Tyler closed T9.6 on the medians, 2026-11-13. What reproduced
// and what did not is in `docs/plan/bundles/B21.md`; two of the spike's figures cannot be rebuilt
// from Track 9's text, are recorded there, and are NOT asserted:
// - The "worst of 40" values: each is one random draw and the spike's seeds are gone, so only the
//   ordering is held (the contiguous cuts' worst case stays under the sha1 split's).
// - The churn of the contiguous cuts (2.8% in the spike), and of the LPT bin-pack (64.6%). The
//   text does not say where the 5% new files sort, so the churn is measured under both readings
//   ("random": new paths anywhere; "sorted last": every new path after every old one), and only
//   the orderings of the spike's table that hold under both are asserted. Measured here (median
//   of the 40 trials, 1,000 files, 4 shards, 50 new files):
//
//                       new paths random   new paths sorted last   spike
//     sha1 split               0.7%                 0.7%             0.7%
//     contiguous cuts          0.3%                 3.2%             2.8%
//     LPT bin-pack            40.9%                33.7%            64.6%
//
//   The spike's 2.8% lies between the two readings and its 64.6% above both, so neither
//   reproduces them. sha1 < contiguous (the spike's order) holds only with the new paths sorted
//   last, so it is not asserted; sha1 and contiguous each far below the LPT bin-pack holds under
//   both, and is.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  generateFiles,
  median,
  movedShare,
  orderRatio,
  seededRandom,
  shardRatio,
  sortedLast,
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
  const extraLast = sortedLast(extra)
  return {
    jest150: orderRatio(files150, 'history', 8),
    jest1000: orderRatio(files1000, 'history', 8),
    alphabetical150: orderRatio(files150, 'alphabetical', 8),
    oracle150: orderRatio(files150, 'oracle', 8),
    sha1: shardRatio(files1000, 4, 2, 'sha1'),
    contiguous: shardRatio(files1000, 4, 2, 'contiguous'),
    sha1Moved: movedShare(files1000, extra, 4, 'sha1'),
    contiguousMoved: movedShare(files1000, extra, 4, 'contiguous'),
    lptMoved: movedShare(files1000, extra, 4, 'lpt'),
    sha1MovedLast: movedShare(files1000, extraLast, 4, 'sha1'),
    contiguousMovedLast: movedShare(files1000, extraLast, 4, 'contiguous'),
    lptMovedLast: movedShare(files1000, extraLast, 4, 'lpt'),
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

  // The spike's table puts the LPT bin-pack's churn (64.6%) far above both the sha1 split's (0.7%)
  // and the contiguous cuts' (2.8%). Held under each reading of where the new files sort, trial by
  // trial (the worst of the two against the best LPT), with no figure of its own.
  const readings = [
    {
      name: 'new paths random',
      sha1: 'sha1Moved',
      contiguous: 'contiguousMoved',
      lpt: 'lptMoved',
    },
    {
      name: 'new paths sorted last',
      sha1: 'sha1MovedLast',
      contiguous: 'contiguousMovedLast',
      lpt: 'lptMovedLast',
    },
  ] as const
  for (const reading of readings) {
    it(`churn, ${reading.name}: the contiguous cuts move far fewer files than the LPT bin-pack`, () => {
      const worst = Math.max(...column(reading.contiguous))
      const best = Math.min(...column(reading.lpt))
      assert.ok(
        worst < best,
        `contiguous worst ${(100 * worst).toFixed(1)}% vs LPT best ${(100 * best).toFixed(1)}%`,
      )
    })

    it(`churn, ${reading.name}: the sha1 split moves far fewer files than the LPT bin-pack`, () => {
      const worst = Math.max(...column(reading.sha1))
      const best = Math.min(...column(reading.lpt))
      assert.ok(
        worst < best,
        `sha1 worst ${(100 * worst).toFixed(1)}% vs LPT best ${(100 * best).toFixed(1)}%`,
      )
    })
  }
})
