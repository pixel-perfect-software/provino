// `eager`: a hook at the place the value is declared (`beforeEach`, or `beforeAll` for a longer
// scope) that evaluates the key as the test sees it, awaits it and keeps the settled value.
import { LazyError } from '../errors.ts'
import { evaluateEager } from './read.ts'
import type { Engine, LazyEntry } from './state.ts'
import { resolveEntry } from './table.ts'

/** True when `entry` is `owner`, or an override (at any depth) of the definition `owner` made. */
function belongsTo(entry: LazyEntry, owner: LazyEntry): boolean {
  for (let e: LazyEntry | null = entry; e !== null; e = e.override ? e.parentEntry : null) {
    if (e === owner) return true
  }
  return false
}

/**
 * The hook function `host.addHook` runs for the eager key of `owner`, the entry that registered
 * it: the hook evaluates only when the test sees `owner` or an override of it, so a nested
 * `lazy.eager` re-declare runs at its own position, not at the outer hook's.
 */
export function eagerHook(engine: Engine, owner: LazyEntry): () => Promise<void> {
  const key = owner.key
  return async () => {
    const frame = engine.host.current()
    if (frame === undefined) {
      throw new LazyError('LAZY_NO_TEST', `the eager value \`${key}\` ran outside a test or hook`)
    }
    const entry = resolveEntry(frame.suite, key)
    // A nested `lazy.let` of the key makes it lazy again, as its type says; a re-declare has its
    // own hook.
    if (!entry.eager || !belongsTo(entry, owner)) return
    await evaluateEager(engine, entry, frame)
  }
}
