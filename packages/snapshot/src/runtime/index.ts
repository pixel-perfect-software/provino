// @provino/snapshot/runtime: what runs in the worker. One `SnapshotState` per test file, the
// lifecycle that follows the file's events, and the pieces of the format `@provino/expect`'s
// snapshot matchers use (that package imports this entry only).
export {
  deepMerge,
  removeExtraLineBreaks,
  SnapshotError,
  type SnapshotErrorCode,
  type SnapshotUpdateMode,
} from '@provino/snapshot'
export { type SnapshotLifecycle, trackSnapshots } from './lifecycle.ts'
export {
  type MatchOptions,
  type MatchResult,
  SnapshotState,
  type SnapshotStateOptions,
} from './state.ts'
