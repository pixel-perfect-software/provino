// `snapshot.contextView` (B23e, D128, compat): what a matcher finds as `this.snapshotState` under
// Jest. jest-snapshot 30.5.2's `SnapshotState` (State.ts L85-L125) is the object Jest puts there,
// and matchers outside Jest read its fields: jest-image-snapshot 6.5.2 counts its images in
// `_counters` (`_counters.set(currentTestName, n + 1)`, through lodash `merge`, which assigns the
// same Map back and so leaves it alone: the Map must be the live one), reads `_updateSnapshot`, and
// writes `added`, `updated`, `matched` and `unmatched` back (`merge(state, { added: added + 1 })`).
// The view gives those fields over Provino's state, so a count written here is the one the file's
// report and the run's Snapshot Summary add up. Those writes go to the fields, not to the attempt's
// record, so a retry keeps them, as Jest's `clear(test)` does (`ecosystem/image-snapshot-retry`:
// a retried image counts on both attempts). The snapshot matchers themselves work on the state
// underneath (`@provino/snapshot/runtime`'s `unwrapSnapshotContext`). The faster path, `null`
// (the state itself), is the neutral value; this one is loaded only by the Jest dialect.
import type { SnapshotContextSource } from '@provino/types'

/**
 * The fields of jest-snapshot's `SnapshotState` that the view carries. Each is an accessor over
 * the file's state; `_counters` and `_updateSnapshot` can't be replaced.
 * @public
 */
export interface JestSnapshotStateView {
  /** How many snapshots each test name has taken: the state's live map. */
  readonly _counters: Map<string, number>
  /** `all` (`-u`), `new`, or `none` (CI). */
  readonly _updateSnapshot: 'all' | 'new' | 'none'
  added: number
  matched: number
  unmatched: number
  updated: number
}

/**
 * Builds Jest's view of a file's snapshot state (`snapshot.contextView`), once per test file.
 * @public
 */
export function jestSnapshotStateView(state: SnapshotContextSource): JestSnapshotStateView {
  return {
    get _counters() {
      return state.liveCounters
    },
    get _updateSnapshot() {
      return state.update
    },
    get added() {
      return state.added
    },
    set added(count: number) {
      state.added = count
    },
    get matched() {
      return state.matched
    },
    set matched(count: number) {
      state.matched = count
    },
    get unmatched() {
      return state.unmatched
    },
    set unmatched(count: number) {
      state.unmatched = count
    },
    get updated() {
      return state.updated
    },
    set updated(count: number) {
      state.updated = count
    },
  }
}
