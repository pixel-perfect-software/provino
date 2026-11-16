---
"provino": minor
"@provino/dialect-jest": minor
"@provino/types": minor
---

A custom matcher that calls jest-snapshot's own matchers with its `this`, as Jest documents (`toMatchSnapshot.call(this, received, hint)`, `toMatchInlineSnapshot`, `toThrowErrorMatchingSnapshot`), runs under `provino jest`. `this.snapshotState` now carries every public member of jest-snapshot 30.5's `SnapshotState` a matcher can use: `match` (Jest's arguments and result), `fail`, `expand`, `snapshotFormat`, `snapshotPath`, `markSnapshotsAsCheckedForTest`, `getUncheckedCount` and `getUncheckedKeys`, beside the fields jest-image-snapshot reads. Before, such a matcher threw `TypeError: snapshotState.match is not a function`. An inline snapshot it takes is written at the custom matcher's call. `@provino/types` adds `SnapshotViewMatchOptions` and `SnapshotViewMatchResult`, and `SnapshotViewSource` gains the members the view is built over; `@provino/dialect-jest/runtime` adds `JestSnapshotMatchOptions` and `JestSnapshotMatchResult`.
