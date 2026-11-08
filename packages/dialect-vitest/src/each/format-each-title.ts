// Vitest 5.0's `.each` titles (T5.4): `formatTitle` from Vitest's runner (`suite.ts`), with the
// `format` and `inspect` of `@vitest/utils` it calls and the pretty-format fork under them,
// vendored in ./vendor. The runner calls it with the row as an array (an object or primitive row
// is `[row]`, which is how `$name` finds an object's keys: it reads the first item) and its
// `taskTitleValueFormatTruncate` setting, 40 by default.
import type { FormatEachTitle } from '@provino/types'
import { VITEST_EACH_TITLE_TRUNCATE } from './title-truncate.ts'
import { formatTitle } from './vendor/runner/title.ts'

/**
 * Formats a `.each` or `.for` title as Vitest 5.0.5 does: `%s %d %i %f %j %o %O %c %%` through
 * its `format`, `%#` and `%$` for the row's index and number, `$name`, `$a.b` and `$0` for an
 * object row's keys or the row's items, and each value cut to 40 characters. `%p` is not a token.
 * @public
 */
export const formatEachTitle: FormatEachTitle = (template, row, index, kind) => {
  // A table of single values hands each row over wrapped (`[item]`); Vitest spreads an array item.
  const items = Array.isArray(row) ? (row as unknown[]) : [row]
  const [only] = items
  const spread = kind === 'mixed' && items.length === 1 && Array.isArray(only) ? only : items
  return formatTitle(template, spread, index, VITEST_EACH_TITLE_TRUNCATE)
}
