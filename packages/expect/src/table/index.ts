// @provino/expect/table: the neutral matcher table (D186, D188), what a project with no dialect
// gets through `NativeRuntimeRefs.matcherTable`. Phase 3 (B27c) builds it; until then the factory
// throws `EXPECT_NOT_IMPLEMENTED`.
import { ExpectError } from '@provino/expect'
import type { MatcherTableFactory } from '@provino/types'

/**
 * Returns Provino's own matcher table.
 * @public
 */
export const provinoExpectTable: MatcherTableFactory = () => {
  throw new ExpectError(
    'EXPECT_NOT_IMPLEMENTED',
    'the neutral matcher table is not built yet (B27c)',
  )
}
