// The custom matchers Jest documents for snapshot testing: each calls one of jest-snapshot's own
// matchers with the matcher's `this`, so jest-snapshot reads and calls `this.snapshotState` as
// Jest's `SnapshotState` (`match`, `fail`, `expand`, `snapshotFormat`, `snapshotPath`).
import { toMatchSnapshot, toThrowErrorMatchingSnapshot } from 'jest-snapshot'

expect.extend({
  // https://jestjs.io/docs/snapshot-testing#custom-snapshot-matchers
  toMatchTrimmedSnapshot(received, length) {
    return toMatchSnapshot.call(this, received.substring(0, length), 'toMatchTrimmedSnapshot')
  },
  // Property matchers: a value that doesn't have them is `snapshotState.fail`.
  toMatchIdSnapshot(received) {
    return toMatchSnapshot.call(this, received, { id: expect.any(Number) })
  },
  toThrowTrimmedSnapshot(received) {
    return toThrowErrorMatchingSnapshot.call(this, received, 'trimmed')
  },
})
