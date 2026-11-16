// Jest's documented custom snapshot matchers under `provino jest` (B23e, D128): the four
// `ecosystem/custom-snapshot-*` recordings of Jest 30.5.2, each run through the bin as the recorder
// ran Jest (`before` first) and held to every capture: the exit code, the kept stderr (the failure
// text and the Snapshot Summary), the results file and the files written.
//
// A matcher calls jest-snapshot's own `toMatchSnapshot`, `toThrowErrorMatchingSnapshot` or
// `toMatchInlineSnapshot` with its `this`, so the real jest-snapshot package calls
// `this.snapshotState.match` and `fail` and reads `expand`, `snapshotFormat` and `snapshotPath`:
// the Jest dialect's `snapshot.contextView` gives it those over Provino's state.
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { FIXTURES as FIXTURE_ROOT } from './recorded.ts'
import { assertMatchesGolden, provinoOn } from './recorded-run.ts'

const FIXTURES = [
  // A first run writes every snapshot: the trimmed text, property matchers, a thrown error.
  'ecosystem/custom-snapshot-add',
  // The stored snapshots under `--ci`: matched.
  'ecosystem/custom-snapshot-match',
  // Other values under `--ci`: jest-snapshot's own failure texts, after `match` and `fail`.
  'ecosystem/custom-snapshot-mismatch',
  // `toMatchInlineSnapshot` from a custom matcher: written at the custom matcher's call, then matched.
  'ecosystem/custom-snapshot-inline',
] as const

const PREFIX = 'custom-snapshot-'

describe('provino jest with a custom matcher over jest-snapshot', () => {
  it('runs every recorded custom-snapshot fixture', async () => {
    const recorded = (await readdir(join(FIXTURE_ROOT, 'ecosystem')))
      .filter((name) => name.startsWith(PREFIX))
      .map((name) => `ecosystem/${name}`)
    assert.deepEqual([...FIXTURES].toSorted(), recorded.toSorted())
  })

  for (const id of FIXTURES) {
    it(`${id} gives Jest's results`, async () => {
      assertMatchesGolden(id, await provinoOn(id))
    })
  }
})
