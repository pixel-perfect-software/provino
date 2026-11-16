// The inline form of Jest's documented custom snapshot matcher: jest-snapshot's
// `toMatchInlineSnapshot` with the matcher's `this`, so the snapshot is written into the test
// file at the custom matcher's call.
import { toMatchInlineSnapshot } from 'jest-snapshot'

expect.extend({
  // https://jestjs.io/docs/snapshot-testing#custom-inline-snapshot-matchers
  toMatchTrimmedInlineSnapshot(received, ...rest) {
    return toMatchInlineSnapshot.call(this, received.substring(0, 10), ...rest)
  },
})
