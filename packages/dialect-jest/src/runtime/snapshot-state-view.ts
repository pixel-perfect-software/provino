// `snapshot.contextView` (B23e, D128, compat): what a matcher finds as `this.snapshotState` under
// Jest. jest-snapshot 30.5.2's `SnapshotState` (State.ts) is the object Jest puts there, and
// matchers outside Jest use it in two ways:
// - jest-image-snapshot 6.5.2 reads and writes its fields: it counts its images in `_counters`
//   (through lodash `merge`, which assigns the same Map back, so the Map must be the live one),
//   reads `_updateSnapshot`, and writes the four counts back (`merge(state, { added: added + 1 })`);
// - a custom matcher calls jest-snapshot's own matchers on it, as Jest documents
//   (`toMatchSnapshot.call(this, received, hint)`), which call `match`, `fail`, and read `expand`,
//   `snapshotFormat` and `snapshotPath` (index.ts `_toMatchSnapshot`, `_toThrowErrorMatchingSnapshot`).
// The view gives every public member of Jest's state a matcher can use over Provino's state, so a
// count written or a snapshot taken through it is the one the file's report and the Snapshot
// Summary add up, and a snapshot taken through it belongs to the running test attempt, which a
// retry takes back. What it leaves out, and why, is `NOT_CARRIED` in its test. Provino's own
// snapshot matchers work on the state underneath (`@provino/snapshot/runtime`'s
// `unwrapMatcherSnapshotState`). The faster path, `null` (the state itself), is the neutral value;
// this one is loaded only by the Jest dialect.
import { matcherCallStack } from '@provino/expect'
import type { SnapshotViewMatchResult, SnapshotViewSource } from '@provino/types'

/**
 * What jest-snapshot's matchers pass to `SnapshotState.match` (State.ts `SnapshotMatchOptions`).
 * @public
 */
export interface JestSnapshotMatchOptions {
  readonly testName: string
  /**
   * jest-circus's test, from the matcher's `currentTestIdentity` (jest-snapshot index.ts L294):
   * Jest's state records the attempt's work against it, for `clear(test)` on a retry. Provino's
   * matcher state has no `currentTestIdentity`, so jest-snapshot passes `undefined`; the view
   * records the snapshot against the attempt the state names (`SnapshotViewSource.currentTestId`).
   */
  readonly testIdentity?: object | undefined
  readonly received: unknown
  readonly key?: string | undefined
  readonly inlineSnapshot?: string | undefined
  readonly isInline: boolean
  /** The error made at a `.resolves`/`.rejects` call: where an inline snapshot is written. */
  readonly error?: Error | undefined
  readonly testFailing?: boolean | undefined
}

/**
 * The members of jest-snapshot's `SnapshotState` the view carries, each over the file's state.
 * `_counters`, `_updateSnapshot`, `snapshotFormat` and `snapshotPath` can't be replaced.
 * @public
 */
export interface JestSnapshotStateView {
  /** How many snapshots each test name has taken: the state's live map. */
  readonly _counters: Map<string, number>
  /** `all` (`-u`), `new`, or `none` (CI). */
  readonly _updateSnapshot: SnapshotViewSource['update']
  /** Snapshots written in this file. */
  added: number
  /** Snapshots that matched the stored ones. */
  matched: number
  /** Snapshots that failed. */
  unmatched: number
  /** Stored snapshots rewritten (`-u`). */
  updated: number
  /** Whether diffs show every line (`--expand`). */
  expand: boolean
  /** The pretty-format options the file's snapshots are serialized with. */
  readonly snapshotFormat: Readonly<Record<string, unknown>>
  /** The file's snapshot file. */
  readonly snapshotPath: string
  /**
   * Compares a value with its stored snapshot, and writes it when the update mode says to, as the
   * running test attempt's (State.ts `SnapshotReturnOptions`).
   */
  match(options: JestSnapshotMatchOptions): SnapshotViewMatchResult
  /**
   * A snapshot that couldn't be taken (its property matchers failed), as the running test
   * attempt's; returns its key.
   */
  fail(testName: string, received: unknown, key?: string, testIdentity?: object): string
  /** Marks a test's stored snapshots as checked, so they are not reported obsolete. */
  markSnapshotsAsCheckedForTest(testName: string): void
  /** How many stored snapshots no test has checked yet. */
  getUncheckedCount(): number
  /** The keys of those snapshots. */
  getUncheckedKeys(): string[]
}

/**
 * Builds Jest's view of a file's snapshot state (`snapshot.contextView`), once per test file.
 * @public
 */
export function jestSnapshotStateView(state: SnapshotViewSource): JestSnapshotStateView {
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
    get expand() {
      return state.expand
    },
    set expand(expand: boolean) {
      state.expand = expand
    },
    get snapshotFormat() {
      return state.serializeFormat
    },
    get snapshotPath() {
      return state.snapshotPath
    },
    match({ testName, received, key, inlineSnapshot, isInline, error, testFailing }) {
      const {
        actual,
        count,
        expected,
        key: stored,
        pass,
      } = state.match({
        testName,
        testId: state.currentTestId(),
        received,
        key,
        inlineSnapshot,
        isInline,
        testFailing,
        stack: isInline ? matcherCallStack(error) : undefined,
      })
      return { actual, count, expected, key: stored, pass }
    },
    fail(testName, _received, key) {
      return state.fail(testName, state.currentTestId(), key)
    },
    markSnapshotsAsCheckedForTest(testName) {
      state.markCheckedForTest(testName)
    },
    getUncheckedCount() {
      return state.getUncheckedCount()
    },
    getUncheckedKeys() {
      return state.getUncheckedKeys()
    },
  }
}
