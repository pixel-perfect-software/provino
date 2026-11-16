// Jest's documented custom snapshot matchers (as `custom-snapshot-add`), whose snapshots a retried
// test takes again: jest-snapshot passes the matcher's `currentTestIdentity` to `match` and `fail`,
// so `snapshotState.clear(test)` takes back what the failed attempt did.
import { toMatchSnapshot } from 'jest-snapshot'

expect.extend({
  // https://jestjs.io/docs/snapshot-testing#custom-snapshot-matchers
  toMatchTrimmedSnapshot(received, length) {
    return toMatchSnapshot.call(this, received.substring(0, length), 'toMatchTrimmedSnapshot')
  },
  // Property matchers: a value that doesn't have them is `snapshotState.fail`.
  toMatchIdSnapshot(received) {
    return toMatchSnapshot.call(this, received, { id: expect.any(Number) })
  },
})
