// A custom matcher over jest-snapshot's `toMatchSnapshot` with the matcher's `this`: on a
// mismatch jest-snapshot prints the diff itself, with `this.snapshotState.expand` and, to
// serialize a multi-line received value again, `this.snapshotState.snapshotFormat`.
import { toMatchSnapshot } from 'jest-snapshot'

expect.extend({
  toMatchShapeSnapshot(received) {
    return toMatchSnapshot.call(this, received, 'shape')
  },
})
