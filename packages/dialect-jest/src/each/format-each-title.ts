// Jest 30.5's `.each` titles (T5.4): jest-each 30.5.2's `formatTitle` and `interpolateVariables`
// (vendored in ./vendor/jest-each), applied to one row at a time. jest-each decides per table
// (`array.ts` `isTemplates`, `normaliseTable`); the policy hands the formatter one row, so the
// decision is made from the row and the title:
//
// - an array row goes through `formatTitle`: the `%` tokens, through `util.format` and
//   pretty-format. A `$variable` stays as written.
// - an object row (an array of objects, or a tagged template's row) with a `%` token in the title
//   is one value for those tokens, as jest-each reads a table that isn't all templates.
// - an object row with none is a template: `$name`, `$a.b` and `$#`, then `%%` becomes `%`.
//
// What one row can't tell, and a table does:
//
// - A tagged template (`template.ts`) reads its title for `$variables` only, so a `%` token stays
//   as written and `%%` stays doubled. The optional fourth argument says the row is from one;
//   without it the row is read as an array of objects is. Core doesn't pass it yet.
// - A table that mixes arrays, objects and primitives: jest-each wraps every cell as one value,
//   and leaves `$name` alone unless every cell is an object. Per row, an array is spread and an
//   object with no `%` token is a template, as in a table of one kind.
import type { EachTableKind } from '@provino/types'
import {
  ESCAPED_PLACEHOLDER_PREFIX,
  formatTitle,
  interpolateEscapedPlaceholders,
  PLACEHOLDER_PREFIX,
  SUPPORTED_PLACEHOLDERS,
} from './vendor/jest-each/array.ts'
import { interpolateVariables } from './vendor/jest-each/interpolation.ts'

// Upstream's regex is global, and testing with it leaves `lastIndex` behind for the next title.
const PLACEHOLDER = new RegExp(SUPPORTED_PLACEHOLDERS.source)

export type { EachTableKind }

/**
 * Formats a `.each` title as jest-each 30.5.2 does: `%p` through pretty-format, `%j` as JSON
 * (a bigint as `"5n"`, a cycle as `[Circular]`), the other tokens through `util.format`, `%#` and
 * `%$` for the row's index and number, and `$name` for an object row's keys. `kind` is
 * `'template'` for a tagged template's row: only its `$variables` are read.
 * @public
 */
export function formatEachTitle(
  template: string,
  row: readonly unknown[] | Readonly<Record<string, unknown>>,
  index: number,
  kind?: EachTableKind,
): string {
  if (Array.isArray(row)) return formatTitle(template, row, index)
  const object = row as Readonly<Record<string, unknown>>
  if (kind === 'template') return interpolateVariables(template, object, index)
  if (PLACEHOLDER.test(interpolateEscapedPlaceholders(template))) {
    return formatTitle(template, [object], index)
  }
  return interpolateVariables(template, object, index).replaceAll(
    ESCAPED_PLACEHOLDER_PREFIX,
    PLACEHOLDER_PREFIX,
  )
}
