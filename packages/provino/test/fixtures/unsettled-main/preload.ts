// Preloaded (`--import`) into a copy of the `provino` bin by `lifecycle.test.ts`: the bin's `main`
// is replaced by one that never settles and holds nothing open, which is what a run whose reporter
// never settles looks like to the bin's top-level `await` once the workers are gone.
import { register } from 'node:module'

register('./hooks.ts', import.meta.url)
