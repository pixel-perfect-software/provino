// @provino/snapshot/node: what runs in the coordinator. The update mode a run uses, the run's
// snapshot totals, and whether they fail the run. The `.snap` files themselves are the worker's.
export { createSnapshotAggregate, type SnapshotAggregate, snapshotRunFails } from './aggregate.ts'
export { testPathOfSnapshot } from './inverse.ts'
export { resolveUpdateMode, type UpdateModeInput } from './update-mode.ts'
