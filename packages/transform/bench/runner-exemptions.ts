// Where our module-runner transform deliberately differs from oracle A (oxc's), by rule, with the
// reason. `bench:runner-diff` and `runner/equivalence.test.ts` print this list by name and fail
// when an entry no longer covers any difference (the pattern of `VITEST_OUTPUT_BROKEN`).
// Test-only.
import type { OracleResult } from './runner-oracle.ts'

export interface Exemption {
  readonly id: string
  readonly reason: string
  /** Whether the difference in this file is the one this entry explains. */
  applies(input: string, expected: OracleResult, actual: OracleResult): boolean
  /**
   * The entry covers a difference in some references only: the rest of the file must still be
   * equal, with those references read alike (`Relax` in `test-oracle.ts`).
   */
  readonly relax?: true
}

export const EXEMPTIONS: readonly Exemption[] = [
  {
    id: 'mixed-default-namespace-import',
    reason:
      "`import d, * as n from 'x'`: oxc leaves the default import `d` unrewritten (a free name, so a ReferenceError at run time), or binds it to the whole namespace. We read `.default`.",
    applies: (input) => /\bimport\s+[\w$]+\s*,\s*\*\s*as\b/.test(input),
    relax: true,
  },
  {
    id: 'duplicate-default-export-in-typescript-input',
    reason:
      'Two `export default` declarations are a SyntaxError in JavaScript. oxc parsed the stripped code as TypeScript (a `.ts` name), where they read as overloads, and emitted two `__vite_ssr_export_default__` constants. We parse JavaScript and report it.',
    applies: (_input, expected, actual) =>
      expected.error === null && actual.error === 'A module cannot have multiple default exports.',
  },
]
