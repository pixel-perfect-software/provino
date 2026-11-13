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

const FRAME_RUN = /(?:\n\s*at [^\n]*)+/g

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
    if (Array.isArray(node)) return node.map((item: Json) => walk(item, key))
    if (typeof node === 'object' && node !== null) {
      return Object.fromEntries(
        Object.entries(node).map(([name, inner]) => [name, walk(inner, name)]),
      )
    }
    return node
  }
  return walk(value, undefined)
}
