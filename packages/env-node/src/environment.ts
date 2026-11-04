// Track 8 T8.2 (node part) and T8.3 (`@provino/env-node`, realm `worker`). The node environment
// does not build a global: test code sees the worker's own, and the file's changes to it are
// undone when the file ends. Realm `context` (a vm context with Node's globals) needs the `realm`
// isolation tier, T2.8.
import type { Environment, EnvironmentInstance } from '@provino/types'
import { NodeEnvironmentError } from './errors.ts'
import { restoreOrThrow, snapshotProperties } from './internal/restore.ts'

/**
 * The Node test environment.
 *
 * `setup` returns the worker's `globalThis` and remembers every own property of it, string and
 * symbol keys, with its descriptor. `teardown` puts the global back: it deletes the keys added
 * since, and redefines every key whose descriptor changed or that was deleted, comparing values
 * and accessor functions by identity and the flags (`writable`, `enumerable`, `configurable`) by
 * value. Afterwards the global's property names and every original descriptor equal the ones
 * `setup` saw. A key that was deleted and restored moves to the end of its group (string keys,
 * then symbols); the order of every key that was never deleted is kept.
 *
 * A key that cannot be restored (an added property that is not configurable, so `delete` fails)
 * does not stop the rest: everything else is restored first, then `teardown` throws a
 * `NodeEnvironmentError` with code `ENV_NODE_RESTORE_FAILED` that names the keys in `failures`.
 * It throws rather than reports because a global left behind would reach the next file in this
 * worker, which is the one thing a file-scoped environment promises not to allow; the isolation
 * tier `realm` gives each file its own global.
 *
 * Call it once per file (scope `file`) or once per worker (scope `worker`). Only the `worker`
 * realm is supported: `setup` throws `ENV_NODE_REALM_UNSUPPORTED` for `context`.
 * @public
 */
export const nodeEnvironment: Environment<'node'> = {
  name: 'node',
  realms: ['worker'],
  setup(context): EnvironmentInstance {
    if (context.realm !== 'worker') {
      throw new NodeEnvironmentError(
        'ENV_NODE_REALM_UNSUPPORTED',
        `The node environment supports the 'worker' realm only, not '${context.realm}'. A vm-context global needs the 'realm' isolation tier (T2.8).`,
      )
    }
    const snapshot = snapshotProperties(globalThis)
    return {
      global: globalThis,
      teardown(): void {
        restoreOrThrow(snapshot)
      },
    }
  },
}
