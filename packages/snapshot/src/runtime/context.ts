// What a matcher finds as `this.snapshotState` (B23e, D128): the file's state, or the dialect's view
// of it (`snapshot.contextView`). A view is linked to the state it was built over in a module
// `WeakMap`, so the snapshot matchers reach the state itself whatever shape the matcher context
// shows, the view object is never written to (a frozen one works), and a link lives no longer than
// its view.
import type { SnapshotContextViewFactory } from '@provino/types'
import type { SnapshotState } from './state.ts'

/** Each view `snapshotContextOf` built, to the state it was built over. */
const stateOfView = new WeakMap<object, SnapshotState>()

/**
 * The value for the matcher context's `snapshotState`: the state itself when the policy has no
 * view, else the view the factory built over it.
 * @public
 */
export function snapshotContextOf(
  state: SnapshotState,
  view: SnapshotContextViewFactory | null,
): object {
  if (view === null) return state
  const context = view(state)
  stateOfView.set(context, state)
  return context
}

/**
 * What the snapshot matchers work on, from a matcher context's `snapshotState`: the state a view
 * `snapshotContextOf` built was built over, else the value as it is (the state itself, or whatever
 * else a test put there, which the matchers then refuse).
 * @public
 */
export function unwrapSnapshotContext(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  return stateOfView.get(value) ?? value
}
