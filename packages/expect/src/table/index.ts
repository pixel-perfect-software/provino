// @provino/expect/table: Provino's own matcher table (D186, D188), what a project with no dialect
// gets through `NativeRuntimeRefs.matcherTable`. Its equality is the vendored `equals` (compat),
// its printing Node's `inspect` and `util.diff` (speed), its words Provino's own.
import { iterableEquality, snapshotMatchers, subsetEquality } from '@provino/expect'
import type { MatcherTableFactory } from '@provino/types'
import { assertionError } from './assertion-error.ts'
import { asymmetric, asymmetricNot, customAsymmetric } from './asymmetric.ts'
import { matchers, promiseMatchers } from './matchers.ts'
import { messages } from './messages.ts'
import { diffLines, show } from './print.ts'

/**
 * The native snapshot printer the table's snapshot matchers print with (`NativeRuntimeRefs.snapshot.printer`),
 * re-exported here so it rides the module a native worker loads at its start (B28): a shim, whose
 * vendored pretty-format loads on the first snapshot.
 * @public
 */
export { nativeSnapshotPrinter } from '@provino/snapshot/printer'

/**
 * Returns Provino's own matcher table.
 * @public
 */
export const provinoExpectTable: MatcherTableFactory = () => {
  // The four snapshot matchers and the promise forms of the two that read a thrown error (B28, ending
  // D189's refusal). `toMatchFileSnapshot` is Vitest's: the native API has none.
  const snapshot = snapshotMatchers({ fileSnapshot: false })
  return {
    matchers: { ...matchers, ...snapshot.matchers },
    promiseMatchers: { ...promiseMatchers, ...snapshot.promiseMatchers },
    asymmetric,
    asymmetricNot,
    // The snapshot matchers check property matchers with the two testers (Jest's `this.utils` has them).
    utils: { stringify: show, diff: diffLines, iterableEquality, subsetEquality },
    messages,
    customAsymmetric,
    // The neutral `errorShape: 'assertion-error'`: a failure throws the table's own error.
    assertionError,
  }
}
