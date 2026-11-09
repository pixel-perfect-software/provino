// @provino/snapshot: the snapshot engine (Track 7 R4). This entry is the part both sides use: the
// `.snap` file's text rules and format, the natural-order compare, and the errors. The per-file
// state machine is `@provino/snapshot/runtime` (worker); the run's summary and the update mode
// are `@provino/snapshot/node` (coordinator). A dialect supplies the printer and the words.
export { SnapshotError, type SnapshotErrorCode } from './errors.ts'
export type { SnapshotUpdateMode } from './mode.ts'
export { defaultSnapshotPath } from './paths.ts'
export {
  checkSnapHeader,
  evaluateSnapFile,
  keyToTestName,
  type SnapshotData,
  serializeSnapFile,
} from './snap-file.ts'
export {
  addExtraLineBreaks,
  escapeBacktickString,
  normalizeNewlines,
  printBacktickString,
  removeExtraLineBreaks,
} from './text.ts'
export { deepMerge } from './vendor/deep-merge.ts'
export { naturalCompare } from './vendor/natural-compare.ts'
