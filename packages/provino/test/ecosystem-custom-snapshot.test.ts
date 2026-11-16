// Jest's documented custom snapshot matchers under `provino jest` (B23e, D128): the
// `ecosystem/custom-snapshot-*` recordings of Jest 30.5.2, each run through the bin as the recorder
// ran Jest (`before` first) and held to every capture: the exit code, the kept stderr (the failure
// text and the Snapshot Summary), the results file and the files written.
//
// A matcher calls jest-snapshot's own `toMatchSnapshot`, `toThrowErrorMatchingSnapshot` or
// `toMatchInlineSnapshot` with its `this`, so the real jest-snapshot package calls
// `this.snapshotState.match` and `fail` and reads `expand`, `snapshotFormat` and `snapshotPath`:
// the Jest dialect's `snapshot.contextView` gives it those over Provino's state.
import { describeRecorded } from './recorded-run.ts'

describeRecorded(
  'provino jest with a custom matcher over jest-snapshot',
  'ecosystem/custom-snapshot-',
  [
    // A first run writes every snapshot: the trimmed text, property matchers, a thrown error.
    'ecosystem/custom-snapshot-add',
    // The stored snapshots under `--ci`: matched.
    'ecosystem/custom-snapshot-match',
    // Other values under `--ci`: jest-snapshot's own failure texts, after `match` and `fail`.
    'ecosystem/custom-snapshot-mismatch',
    // `toMatchInlineSnapshot` from a custom matcher: written at the custom matcher's call, then matched.
    'ecosystem/custom-snapshot-inline',
    // Inline matchers called through `expect` inside custom matchers: written into their bodies.
    'ecosystem/custom-snapshot-inline-nested',
    // `jest.retryTimes(1)` under `--ci`: the retry takes back the failed attempt's snapshots.
    'ecosystem/custom-snapshot-retry',
    // The same on a first local run: the .snap holds each key once.
    'ecosystem/custom-snapshot-retry-new',
  ],
)
