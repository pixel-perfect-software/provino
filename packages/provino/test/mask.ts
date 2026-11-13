// How a `json:` capture is recorded (`@provino/harness` `record.ts` `normalizedJson`), for the
// Provino side of a comparison. A copy, like `sweep.ts`: `provino` may not import the harness.
// Every string has each root as `<root>`, each run of stack frames as `\n<frames>` and each mask
// match as `<masked>`; every number under a time key is `"<time>"`.
export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json }

// A copy of the recorder's `FRAME_RUN` (`packages/harness/src/record.ts`): change both.
const FRAME_RUN =
  /(?:\n[ \t]+at (?:[^\n]* \((?:[^\n]*:\d+:\d+|<anonymous>|native|index \d+)\)|[^\n ]+:\d+:\d+)(?=\n|$))+/g

function byName(a: Json, b: Json): number {
  const name = (value: Json): string => {
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as { name?: unknown }).name === 'string'
    ) {
      return (value as { name: string }).name
    }
    throw new Error('a "testResults" entry has no string "name"')
  }
  return name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0
}

/**
 * What the recorder does to a captured stream or file: each root as `<root>`, then (for a stream)
 * only the lines `keepLines` matches, then each `mask` match as `<masked>`. Both sides of a
 * comparison read their text through this, so they cannot differ in the steps.
 */
export function observedText(
  raw: string,
  options: {
    readonly roots: readonly string[]
    readonly keepLines?: string | undefined
    readonly mask?: readonly string[] | undefined
  },
): string {
  let out = raw
  for (const root of options.roots) out = out.replaceAll(root, '<root>')
  if (options.keepLines !== undefined) {
    const keep = new RegExp(options.keepLines)
    out = out
      .split('\n')
      .filter((line) => keep.test(line))
      .join('\n')
  }
  return (options.mask ?? []).reduce(
    (masked, source) => masked.replace(new RegExp(source, 'gm'), '<masked>'),
    out,
  )
}

export function normalizedJson(
  value: Json,
  options: {
    readonly roots: readonly string[]
    readonly timeKeys: readonly string[]
    readonly mask?: readonly string[] | undefined
  },
): Json {
  const expressions = (options.mask ?? []).map((source) => new RegExp(source, 'gm'))
  const text = (raw: string): string => {
    let out = raw
    for (const root of options.roots) out = out.replaceAll(root, '<root>')
    out = out.replace(FRAME_RUN, '\n<frames>')
    return expressions.reduce((masked, expression) => masked.replace(expression, '<masked>'), out)
  }
  const walk = (node: Json, key: string | undefined): Json => {
    if (typeof node === 'string') return text(node)
    if (typeof node === 'number') {
      return key !== undefined && options.timeKeys.includes(key) ? '<time>' : node
    }
    if (Array.isArray(node)) {
      const items = node.map((item: Json) => walk(item, key))
      // Jest lists `testResults` in the order its files finished: a canonical order by file name.
      return key === 'testResults' ? items.toSorted(byName) : items
    }
    if (typeof node === 'object' && node !== null) {
      return Object.fromEntries(
        Object.entries(node).map(([name, inner]) => [name, walk(inner, name)]),
      )
    }
    return node
  }
  return walk(value, undefined)
}
