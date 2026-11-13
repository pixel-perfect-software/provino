// `createLazyRuntime`: what the worker builds from the runtime's `LazyHost` and the `lazy` policy.
import type { LazyEvaluation, LazyHost, LazyPolicy, TestRunHandle } from '@provino/types'
import type { LazyRoot } from '../types.ts'
import { createHandles } from './handle.ts'
import { logOf } from './read.ts'
import { createShared, type DescribeFn, type SharedFunctions } from './shared.ts'
import type { Engine } from './state.ts'

/**
 * What `createLazyRuntime` needs.
 * @beta
 */
export interface LazyRuntimeOptions {
  readonly host: LazyHost
  readonly policy: LazyPolicy
  /** The worker's `describe` (`runtime.api.describe`): `itBehavesLike` opens a nested one. */
  readonly describe: DescribeFn
}

/**
 * The whole runtime the slot holds: the root handle, the shared-example functions and the report
 * data.
 * @beta
 */
export interface LazyCore extends SharedFunctions {
  readonly lazy: LazyRoot
  evaluatedLazies(run: TestRunHandle): readonly LazyEvaluation[]
}

/**
 * Builds the lazy runtime over a host. It keeps no global state: everything is in the host's slots.
 * @beta
 */
export function createLazyRuntime(options: LazyRuntimeOptions): LazyCore {
  const engine: Engine = { host: options.host, policy: options.policy, stack: [] }
  const makeHandle = createHandles(engine)
  return {
    ...createShared(engine, makeHandle, options.describe),
    lazy: makeHandle([]) as unknown as LazyRoot,
    evaluatedLazies: (run) => logOf(run.slots),
  }
}
