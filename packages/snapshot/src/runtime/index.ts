// @provino/snapshot/runtime: what runs in the worker. One `SnapshotState` per test file, the
// lifecycle that follows the file's events, and the pieces of the format `@provino/expect`'s
// snapshot matchers and the worker use (those packages import this entry only).
export {
  deepMerge,
  defaultSnapshotPath,
  removeExtraLineBreaks,
  SnapshotError,
  type SnapshotErrorCode,
  type SnapshotUpdateMode,
} from '@provino/snapshot'
export { type SnapshotLifecycle, trackSnapshots } from './lifecycle.ts'
export { type OpenSnapshotsOptions, openFileSnapshots } from './open.ts'
export {
  type MatchOptions,
  type MatchResult,
  SnapshotState,
  type SnapshotStateOptions,
} from './state.ts'
