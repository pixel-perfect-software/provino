// jest-image-snapshot 6.5.2 under `provino jest` (B23e Phase 2c): the six `ecosystem/image-snapshot-*`
// recordings of Jest 30.5.2, each run through the bin as the recorder ran Jest (`before` first) and
// held to every capture: the exit code, the kept stderr (the failure text and the Snapshot
// Summary), the results file and `image-hashes.txt`, the sha256 of every image written.
//
// The matcher reads `this.snapshotState` as Jest's `SnapshotState` (State.ts): the live `_counters`
// Map it shares with `toMatchSnapshot`, `_updateSnapshot`, and the `added`, `matched`, `unmatched`
// and `updated` counts it writes back through lodash `merge`. The Jest dialect's
// `snapshot.contextView` gives it that shape over Provino's state (D128), and the counts it writes
// are the ones the totals add up. The diff runs in jest-image-snapshot's own `spawnSync` child
// (`runInProcess: false`, its default), which ends with the call.
import { describe, it } from 'node:test'
import { assertMatchesGolden, provinoOn } from './recorded-run.ts'

const FIXTURES = [
  // A new image and a shared counter: `counter`'s image is its second snapshot.
  'ecosystem/image-snapshot-add',
  // A stored image under CI: matched.
  'ecosystem/image-snapshot-match',
  // One differing pixel: the failure text, the diff image and `unmatched`.
  'ecosystem/image-snapshot-mismatch',
  // `-u` rewrites the stored image: `updated`.
  'ecosystem/image-snapshot-update',
  // `--ci` with nothing stored: jest-image-snapshot's own "not written" failure.
  'ecosystem/image-snapshot-ci',
  // `jest.retryTimes(1)`: the matcher reads the file's retry count, and a retry takes back only
  // what jest-snapshot itself counted (the image matcher's own writes stay, as in Jest).
  'ecosystem/image-snapshot-retry',
] as const

describe('provino jest with jest-image-snapshot', () => {
  for (const id of FIXTURES) {
    it(`${id} gives Jest's results`, async () => {
      assertMatchesGolden(id, await provinoOn(id))
    })
  }
})
