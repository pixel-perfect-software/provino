// Track 8 T8.2 (node part) and T8.3 (`@provino/env-node`, realm `worker`). The node environment
// does not build a global: test code sees the worker's own, and the file's changes to it are
// undone when the file ends. Realm `context` (a vm context with Node's globals) needs the `realm`
// isolation tier, T2.8.
import { leakReport, snapshotProperties } from '@provino/env-shared'
import type { Environment, EnvironmentInstance, EnvironmentTeardownReport } from '@provino/types'
import { NodeEnvironmentError } from './errors.ts'

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
 * An assignment to a get/set accessor whose value lives in a closure (Node's `process`, `Buffer`
 * and `performance`) leaves the descriptor unchanged, so `setup` wraps those setters: the first
 * assignment records the old value, `teardown` assigns it back and puts the original setter back.
 *
 * A key that cannot be restored (an added property that is not configurable, so `delete` fails)
 * is a warning, not a failure (decision D22): `teardown` restores everything else, then returns
 * an `EnvironmentTeardownReport` that names the keys in `leakedGlobals`. The file passes; the
 * worker warns and tells the coordinator, which recycles the worker. A clean teardown returns
 * nothing. The isolation tier `realm` gives each file its own global.
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
      teardown(): EnvironmentTeardownReport | undefined {
        return leakReport(snapshot.restore())
      },
    }
  },
}
