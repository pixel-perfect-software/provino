// `eager`: a hook at the place the value is declared (`beforeEach`, or `beforeAll` for a longer
// scope) that evaluates the key as the test sees it, awaits it and keeps the settled value.
import { LazyError } from '../errors.ts'
import { evaluateEager } from './read.ts'
import type { Engine } from './state.ts'
import { resolveEntry } from './table.ts'

/** The hook function `host.addHook` runs for the eager key `key`. */
export function eagerHook(engine: Engine, key: string): () => Promise<void> {
  return async () => {
    const frame = engine.host.current()
    if (frame === undefined) {
      throw new LazyError('LAZY_NO_TEST', `the eager value \`${key}\` ran outside a test or hook`)
    }
    const entry = resolveEntry(frame.suite, key)
    // A nested `lazy.let` of the key makes it lazy again, as its type says.
    if (!entry.eager) return
    await evaluateEager(engine, entry, frame)
  }
}
