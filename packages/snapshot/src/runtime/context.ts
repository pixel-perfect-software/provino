// What a matcher finds as `this.snapshotState` (B23e, D128): the file's state, or the dialect's view
// of it (`snapshot.contextView`). A view is built over the state and carries it under a symbol, so
// the snapshot matchers reach the state itself whatever shape the matcher context shows.
import type { SnapshotContextViewFactory } from '@provino/types'
import type { SnapshotState } from './state.ts'

/** Where a view keeps the state it was built over. Non-enumerable, so no walk of the view sees it. */
const STATE = Symbol('provino.snapshotState')

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
  Object.defineProperty(context, STATE, { value: state })
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
  return Object.hasOwn(value, STATE) ? Reflect.get(value, STATE) : value
}
