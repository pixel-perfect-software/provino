// What a matcher finds as `this.snapshotState` (B23e, D128): the file's state, or the dialect's view
// of it (`snapshot.contextView`). A view is linked to the state it was built over in a module
// `WeakMap`, so the snapshot matchers reach the state itself whatever shape the matcher's
// `snapshotState` has, the view is never written to (a frozen one works), and a link lives no
// longer than its view.
import type { SnapshotViewFactory } from '@provino/types'
import type { SnapshotState } from './state.ts'

/** Each view `matcherSnapshotStateOf` built, to the state it was built over. */
const stateOfView = new WeakMap<object, SnapshotState>()

/**
 * The value for the matcher's `snapshotState`: the state itself when the policy has no view, else
 * the view the factory built over it.
 */
export function matcherSnapshotStateOf(
  state: SnapshotState,
  view: SnapshotViewFactory | null,
): object {
  if (view === null) return state
  const built = view(state)
  stateOfView.set(built, state)
  return built
}

/**
 * What the snapshot matchers work on, from a matcher's `snapshotState`: the state a view
 * `openFileSnapshots` built was built over, else the value as it is (the state itself, or whatever
 * else a test put there, which the matchers then refuse).
 * @public
 */
export function unwrapMatcherSnapshotState(value: unknown): unknown {
  // `WeakMap.get` answers `undefined` for a primitive, so any value can be asked about.
  return stateOfView.get(value as object) ?? value
}
