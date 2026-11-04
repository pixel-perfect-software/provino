// An environment whose teardown throws, for the worker check's stop-time test. The real node
// environment no longer throws for a global it cannot remove (decision D22: that is a warning), so
// a teardown that fails with an error needs a stand-in. It runs in the worker's own realm and
// installs into `globalThis`, so a test using it runs a fork, never the test process.
import type { Environment } from '@provino/types'

/**
 * A worker-realm environment whose `teardown` always throws.
 * @internal
 */
export const throwingEnvironment: Environment<'throwing', Record<string, never>> = {
  name: 'throwing',
  realms: ['worker'],
  setup() {
    return {
      global: globalThis,
      teardown() {
        throw new Error('the environment’s teardown exploded')
      },
    }
  },
}
