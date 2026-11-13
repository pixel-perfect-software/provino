// `createLazyRuntime`: what the worker builds from the runtime's `LazyHost` and the `lazy` policy.
import type { LazyHost, LazyPolicy, TestRunHandle } from '@provino/types'
import type { EvaluatedLazy, LazyRoot } from '../types.ts'
import { createHandles } from './handle.ts'
import { logOf } from './read.ts'
import type { Engine } from './state.ts'

/**
 * What `createLazyRuntime` needs.
 * @beta
 */
export interface LazyRuntimeOptions {
  readonly host: LazyHost
  readonly policy: LazyPolicy
}

/**
 * The root handle and the report data. B24c adds the shared-example functions to make the whole
 * `LazyRuntime` the slot holds.
 * @beta
 */
export interface LazyCore {
  readonly lazy: LazyRoot
  evaluatedLazies(run: TestRunHandle): readonly EvaluatedLazy[]
}

/**
 * Builds the lazy runtime over a host. It keeps no global state: everything is in the host's slots.
 * @beta
 */
export function createLazyRuntime(options: LazyRuntimeOptions): LazyCore {
  const engine: Engine = { host: options.host, policy: options.policy, stack: [] }
  const makeHandle = createHandles(engine)
  return {
    lazy: makeHandle([]) as unknown as LazyRoot,
    evaluatedLazies: (run) => logOf(run.slots),
  }
}
