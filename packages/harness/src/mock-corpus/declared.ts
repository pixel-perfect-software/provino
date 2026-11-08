// The mock corpus's declared divergences (B13a), shared by `mock-corpus.test.ts` and T1.7's
// `policy-truth/corpora.ts`, so both hold a run to the same allowance.
import type { Declared } from './compare.ts'

/**
 * The cases whose observation differs from the golden, by `fixture (profile) case`. The check fails
 * on a difference not listed here, on a listed case that now matches the golden, and on a listed
 * case whose line is not the one pinned here, so an entry cannot go stale or widen.
 */
export const MOCK_DECLARED: Readonly<Record<string, Declared>> = {
  // The methods live on one frozen prototype per policy, so a mock's only own key is `mock`.
  'mocking/fn-shape (jest) Object.keys of a mock function': {
    divergence: 'DV8',
    line: '{"id":"Object.keys of a mock function","value":["mock"]}',
  },
  'mocking/fn-shape (vitest) Object.keys of a mock function': {
    divergence: 'DV8',
    line: '{"id":"Object.keys of a mock function","value":["mock"]}',
  },
  // Jest's own teardown `restoreAllMocks()` throws after a frozen spy; ours restores what was
  // installed and does not throw. The throw from the spy itself still matches.
  'mocking/hazard-frozen-spy (jest) restoreAllMocks after the failed spy': {
    divergence: 'DV7',
    line: '{"id":"restoreAllMocks after the failed spy","value":"did not throw"}',
  },
}
