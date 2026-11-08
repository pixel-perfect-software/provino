// The cheap check before any parse (Track 3 F4, B13b Gap 2): over every name the policy hoists, reads
// or rewrites, followed by `(` with only whitespace and comments between, or any `\u`, because an
// identifier can spell a name with an escape. A hit in a comment or string just costs a parse.
import type { HoistPolicy } from '@provino/types'

const cache = new WeakMap<HoistPolicy, RegExp | null>()

/** Whitespace, a line comment or a block comment, each matched one way so nothing backtracks. */
const GAP = String.raw`(?:\s|//[^\n\r]*|/\*[^*]*\*+(?:[^/*][^*]*\*+)*/)*`

function escapeRegex(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The regex for a policy, or `null` when the policy names nothing to look for. */
export function prefilterFor(policy: HoistPolicy): RegExp | null {
  const known = cache.get(policy)
  if (known !== undefined) return known
  const names = new Set([
    ...Object.keys(policy.hoistCalls),
    ...policy.hoistValues,
    ...policy.rewriteImportArg,
  ])
  const regex =
    names.size === 0
      ? null
      : new RegExp(`\\b(?:${[...names].map(escapeRegex).join('|')})${GAP}\\(|\\\\u`)
  cache.set(policy, regex)
  return regex
}
