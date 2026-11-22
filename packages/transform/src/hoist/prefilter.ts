// The cheap check before any parse (Track 3 F4, B13b Gap 2). A policy with a global or a bare-name
// mock object (the dialects') gets a regex over every name it hoists, reads or rewrites, followed
// by `(` with only whitespace and comments between, or any `\u`, because an identifier can spell a
// name with an escape. A hit in a comment or string just costs a parse.
//
// A policy whose mock objects and calls are all imports (the native one: `importedCalls`, and
// `import`/`namespace-member` matchers) can only act on a file that names one of their modules,
// so the file must contain a module's specifier first, then one of the names as a word anywhere
// (which also covers a renamed import, `'mock' as m`, `mock /* c */ as m`, and `p['mock']`), or
// a `\u`. The one case it skips: an import source spelled with a string escape
// (`from 'pro\u0076ino'`).
import type { HoistPolicy } from '@provino/types'

/** What the hoister asks before it parses: may this file hold a call the policy acts on? */
export interface Prefilter {
  test(code: string): boolean
}

const cache = new WeakMap<HoistPolicy, Prefilter | null>()

/** Whitespace, a line comment or a block comment, each matched one way so nothing backtracks. */
const GAP = String.raw`(?:\s|//[^\n\r]*|/\*[^*]*\*+(?:[^/*][^*]*\*+)*/)*`

function escapeRegex(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The modules every mock object and call of `policy` is imported from, or `null` if any isn't. */
function importedModules(policy: HoistPolicy): readonly string[] | null {
  const modules = new Set((policy.importedCalls ?? []).map((call) => call.module))
  for (const matcher of policy.objects) {
    if (matcher.kind === 'global' || matcher.kind === 'name') return null
    modules.add(matcher.module)
  }
  return modules.size === 0 ? null : [...modules]
}

/** The prefilter for a policy, or `null` when the policy names nothing to look for. */
export function prefilterFor(policy: HoistPolicy): Prefilter | null {
  const known = cache.get(policy)
  if (known !== undefined) return known
  const names = [
    ...new Set([
      ...Object.keys(policy.hoistCalls),
      ...policy.hoistValues,
      ...policy.rewriteImportArg,
    ]),
  ].map(escapeRegex)
  const modules = importedModules(policy)
  let prefilter: Prefilter | null = null
  if (names.length > 0 && modules === null) {
    prefilter = new RegExp(`\\b(?:${names.join('|')})${GAP}\\(|\\\\u`)
  } else if (names.length > 0 && modules !== null) {
    const word = new RegExp(`\\b(?:${names.join('|')})\\b|\\\\u`)
    prefilter = { test: (code) => modules.some((m) => code.includes(m)) && word.test(code) }
  }
  cache.set(policy, prefilter)
  return prefilter
}
