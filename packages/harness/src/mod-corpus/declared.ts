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
}
