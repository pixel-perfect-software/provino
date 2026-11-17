// The keys that make a worker evaluate shared externals per file (D127, D129, D132; B23f), as one
// predicate and one override, so the loader, the worker and the coordinator agree on them and a
// key added later can't be missed by one of them: `ReevaluateKey` is every `ModulePolicy` key
// named `reevaluate…`, and `NO_REEVALUATION` must name each of them.
import type { ModulePolicy } from '@provino/types'

/**
 * The `ModulePolicy` keys that turn on evaluating shared externals per file.
 * @public
 */
export type ReevaluateKey = Extract<keyof ModulePolicy, `reevaluate${string}`>

/**
 * Every reevaluate key off: what a loader that outlives its files spreads over its policy (the
 * coordinator's). A new key fails to compile here until it is listed.
 * @public
 */
export const NO_REEVALUATION: { readonly [K in ReevaluateKey]: false } = {
  reevaluateHookingExternals: false,
  reevaluatePatchingExternals: false,
}

const REEVALUATE_KEYS: readonly ReevaluateKey[] = Object.keys(NO_REEVALUATION).filter(
  (key): key is ReevaluateKey => key in NO_REEVALUATION,
)

/**
 * Whether a policy evaluates shared externals per file: any reevaluate key on. The loader then
 * opens a window on each external's first load and inlines what it learns; what a window counts
 * (a read, a write) is the worker's watcher's business.
 * @public
 */
export function reevaluatesExternals(policy: Pick<ModulePolicy, ReevaluateKey>): boolean {
  return REEVALUATE_KEYS.some((key) => policy[key])
}
