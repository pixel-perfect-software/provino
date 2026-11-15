---
"provino": minor
"@provino/dialect-jest": minor
"@provino/types": minor
---

jest-image-snapshot runs under `provino jest`. Its `toMatchImageSnapshot` finds `this.snapshotState` as jest-snapshot 30.5's `SnapshotState`: the live `_counters` map it shares with `toMatchSnapshot`, `_updateSnapshot`, and the `added`, `matched`, `unmatched` and `updated` counts it writes back, which the totals and the Snapshot Summary now count. New images, matches, mismatches with their diff, `-u` and `--ci` give what Jest 30.5.2 gives.

The `snapshot` policy slice gains `contextView` (`Behaviour<SnapshotContextViewFactory> | null`): what a matcher sees as `this.snapshotState`. `null` (the neutral and Vitest value) is the file's state itself; the Jest dialect's is `@provino/dialect-jest/runtime`'s `jestSnapshotStateView` (with its `JestSnapshotStateView` type). `@provino/types` adds `SnapshotContextSource` and `SnapshotContextViewFactory`.
