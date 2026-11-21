// @provino/expect/table: Provino's own matcher table (D186, D188), what a project with no dialect
// gets through `NativeRuntimeRefs.matcherTable`. Its equality is the vendored `equals` (compat),
// its printing Node's `inspect` and `util.diff` (speed), its words Provino's own.
import type { MatcherTableFactory } from '@provino/types'
import { asymmetric, asymmetricNot, customAsymmetric } from './asymmetric.ts'
import { matchers, promiseMatchers } from './matchers.ts'
import { messages } from './messages.ts'
import { diffLines, show } from './print.ts'

/**
 * Returns Provino's own matcher table.
 * @public
 */
export const provinoExpectTable: MatcherTableFactory = () => ({
  matchers,
  promiseMatchers,
  asymmetric,
  asymmetricNot,
  utils: { stringify: show, diff: diffLines },
  messages,
  customAsymmetric,
})
