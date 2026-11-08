// The mod corpus's declared divergences (B13b), shared by `mod-corpus.test.ts` and T1.7's
// `policy-truth/corpora.ts`, so both hold a run to the same allowance.
import type { Declared } from '../mock-corpus/compare.ts'

/**
 * The cases whose observation differs from the golden, by `fixture (profile) case`. The check fails
 * on a difference not listed here, on a listed case that now matches, and on a listed case whose
 * line is not the one pinned here.
 */
export const MOD_DECLARED: Readonly<Record<string, Declared>> = {
  // Vitest 5.0.5 hoists a helper that calls `vi.mock` and then reads an `import { count as x }`
  // that the helper re-exports with `export { x }` as `undefined`, always. A bug; we keep the
  // binding live, as Jest and a plain module do (the `export { count } from` form is live in both).
  'mocking/mod-reexport-live (vitest) before any change all three read 0': {
    divergence: 'DV11',
    line: '{"id":"before any change all three read 0","value":{"source":0,"reExported":0,"importedThenExported":0}}',
  },
  'mocking/mod-reexport-live (vitest) after the source changes count, both re-exports follow': {
    divergence: 'DV11',
    line: '{"id":"after the source changes count, both re-exports follow","value":{"source":2,"reExported":2,"importedThenExported":2}}',
  },
  'mocking/mod-reexport-live (vitest) a change made through the re-exported function is seen by all three':
    {
      divergence: 'DV11',
      line: '{"id":"a change made through the re-exported function is seen by all three","value":{"source":3,"reExported":3,"importedThenExported":3}}',
    },
  // Jest 30.5.2 runs a test file in a vm script, and an `import()` that its transformer leaves
  // as written (babel-jest with the CommonJS plugin, as this fixture records it) throws without
  // `--experimental-vm-modules`. We load it, as Vitest does (B13c Gap 6); a Jest-green suite never
  // has this, so nothing green turns red (D7).
  'mocking/mod-dynamic-only (jest) import() from a file with no other module syntax loads the module and its imports':
    {
      divergence: 'DV18',
      line: '{"id":"import() from a file with no other module syntax loads the module and its imports","value":{"value":"base-target","described":"default of base-target"}}',
    },
  'mocking/mod-dynamic-only (jest) a second import() of the same module gets the same instance': {
    divergence: 'DV18',
    line: '{"id":"a second import() of the same module gets the same instance","value":true}',
  },
}
