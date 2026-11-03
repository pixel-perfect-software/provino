// `.each`/`.for` rows: arrays, objects and Jest/Vitest's tagged-template tables. Titles go through
// the policy's `formatEachTitle`; argument shapes follow Track 5 Findings (array rows spread,
// other rows are one argument).

/** One row and the arguments it passes to the test function. */
export interface EachRow {
  readonly row: readonly unknown[] | Readonly<Record<string, unknown>>
  readonly args: readonly unknown[]
  /** The row as `.for` passes it: unspread. */
  readonly item: unknown
}

/**
 * Normalizes `.each`/`.for`'s arguments to rows. A template call (`test.each\`a | b\``) becomes
 * object rows keyed by the heading; anything else is taken as the list of rows.
 *
 * Throws a `TypeError` for something that is not a table. A `strict` read also rejects a table
 * with no rows and a template whose values don't fill its last row; otherwise the incomplete row
 * is dropped (`collect.eachTableError`).
 */
export function eachRows(cases: unknown, values: readonly unknown[], strict: boolean): EachRow[] {
  const rows = isTemplate(cases) ? templateRows(cases, values, strict) : listRows(cases)
  if (strict && rows.length === 0) throw new TypeError('`.each` was called with an empty table')
  return rows
}

function listRows(cases: unknown): EachRow[] {
  if (!Array.isArray(cases)) {
    throw new TypeError('`.each` and `.for` expect an array of rows or a tagged template table')
  }
  // Both runners spread array rows only when every row is an array (Vitest's `arrayOnlyCases`,
  // jest-each's `isTable`); in a mixed table each row is one argument.
  const spread = cases.every((item: unknown) => Array.isArray(item))
  return cases.map((item: unknown) => toRow(item, spread))
}

function toRow(item: unknown, spread: boolean): EachRow {
  if (Array.isArray(item)) return { row: item, args: spread ? item : [item], item }
  if (typeof item === 'object' && item !== null) {
    return { row: item as Record<string, unknown>, args: [item], item }
  }
  return { row: [item], args: [item], item }
}

function isTemplate(value: unknown): value is TemplateStringsArray {
  return Array.isArray(value) && 'raw' in value && Array.isArray((value as { raw: unknown }).raw)
}

function templateRows(
  strings: TemplateStringsArray,
  values: readonly unknown[],
  strict: boolean,
): EachRow[] {
  const headings = (strings[0] ?? '')
    .replace(/\s/g, '')
    .split('|')
    .filter((heading) => heading !== '')
  if (headings.length === 0) throw new TypeError('A `.each` table needs a heading row')
  if (strict && values.length % headings.length !== 0) {
    throw new TypeError(
      `A \`.each\` table with ${headings.length} columns got ${values.length} values`,
    )
  }
  const rows: EachRow[] = []
  const count = Math.floor(values.length / headings.length)
  for (let start = 0; start < count * headings.length; start += headings.length) {
    const row: Record<string, unknown> = {}
    headings.forEach((heading, index) => {
      row[heading] = values[start + index]
    })
    rows.push({ row, args: [row], item: row })
  }
  return rows
}
