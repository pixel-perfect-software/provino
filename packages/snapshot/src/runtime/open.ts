import { defaultSnapshotPath, SnapshotError, type SnapshotUpdateMode } from '@provino/snapshot'
import type {
  ResolveSnapshotPath,
  SnapshotKey,
  SnapshotPolicy,
  SnapshotPrinter,
} from '@provino/types'
import { type SnapshotLifecycle, trackSnapshots } from './lifecycle.ts'
import { SnapshotState } from './state.ts'

/**
 * What a worker needs to open one test file's snapshots. The behaviours (`key`, `printer`,
 * `resolvePath`) are the policy's refs, loaded once per worker.
 * @public
 */
export interface OpenSnapshotsOptions {
  readonly testPath: string
  readonly update: SnapshotUpdateMode
  readonly expand: boolean
  readonly policy: SnapshotPolicy
  readonly key: SnapshotKey
  /** `null`: the policy names no printer, and a snapshot assertion fails with `SNAPSHOT_NO_PRINTER`. */
  readonly printer: SnapshotPrinter | null
  /** `null`: the default layout beside the test file. */
  readonly resolvePath: ResolveSnapshotPath | null
}

/**
 * A printer that refuses: for a policy that names none. Opening the file's state still works, so
 * a file without snapshot assertions runs as before.
 */
function missingPrinter(): SnapshotPrinter {
  const refuse = (): never => {
    throw new SnapshotError(
      'SNAPSHOT_NO_PRINTER',
      'This project has no snapshot printer: the snapshot policy names none (`snapshot.printer`), so a snapshot can neither be written nor compared',
    )
  }
  return {
    serialize: refuse,
    messages: { mismatch: refuse, notWritten: refuse, propertiesMismatch: refuse },
  }
}

/**
 * Opens a test file's snapshots: its state (reading the `.snap` file) and the lifecycle that
 * follows the file's events.
 * @public
 */
export function openFileSnapshots(options: OpenSnapshotsOptions): {
  readonly state: SnapshotState
  readonly lifecycle: SnapshotLifecycle
} {
  const { testPath, policy } = options
  const snapshotPath =
    options.resolvePath === null
      ? defaultSnapshotPath(testPath, policy)
      : options.resolvePath(testPath, policy.extension)
  const state = new SnapshotState({
    testPath,
    snapshotPath,
    update: options.update,
    expand: options.expand,
    policy,
    key: options.key,
    printer: options.printer ?? missingPrinter(),
  })
  return { state, lifecycle: trackSnapshots(state, { keyJoin: policy.keyJoin }) }
}
