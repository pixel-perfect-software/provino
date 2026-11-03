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
 */
export function eachRows(cases: unknown, values: readonly unknown[]): EachRow[] {
  if (isTemplate(cases)) return templateRows(cases, values)
  if (!Array.isArray(cases)) {
    throw new TypeError('`.each` and `.for` expect an array of rows or a tagged template table')
  }
  return cases.map((item: unknown) => toRow(item))
}

function toRow(item: unknown): EachRow {
  if (Array.isArray(item)) return { row: item, args: item, item }
  if (typeof item === 'object' && item !== null) {
    return { row: item as Record<string, unknown>, args: [item], item }
  }
  return { row: [item], args: [item], item }
}

function isTemplate(value: unknown): value is TemplateStringsArray {
  return Array.isArray(value) && 'raw' in value && Array.isArray((value as { raw: unknown }).raw)
}

function templateRows(strings: TemplateStringsArray, values: readonly unknown[]): EachRow[] {
  const headings = (strings[0] ?? '')
    .replace(/\s/g, '')
    .split('|')
    .filter((heading) => heading !== '')
  if (headings.length === 0) throw new TypeError('A `.each` table needs a heading row')
  if (values.length % headings.length !== 0) {
    throw new TypeError(
      `A \`.each\` table with ${headings.length} columns got ${values.length} values`,
    )
  }
  const rows: EachRow[] = []
  for (let start = 0; start < values.length; start += headings.length) {
    const row: Record<string, unknown> = {}
    headings.forEach((heading, index) => {
      row[heading] = values[start + index]
    })
    rows.push({ row, args: [row], item: row })
  }
  return rows
}
