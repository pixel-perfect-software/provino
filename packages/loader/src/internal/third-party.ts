// Which resolved files are `node_modules` files the loader may treat as third party: the one
// question the claims, the records and the loader's seeding share.
import { inGraph } from '../graph/index.ts'

/** `LoaderOptions.inline`: packages (or paths) evaluated per file, never shared natively. */
export type InlineRules = readonly (string | RegExp)[]

export const NO_RULES: InlineRules = []

/** Whether `path` is a `node_modules` file `inline` doesn't name. */
export function isThirdParty(path: string, rules: InlineRules): boolean {
  if (!inGraph(path)) return false
  return !rules.some((rule) =>
    typeof rule === 'string' ? path.includes(`/node_modules/${rule}/`) : rule.test(path),
  )
}

/**
 * Whether a file is a node_modules file the loader could evaluate itself, as a module it inlines:
 * third party, and no addon or WebAssembly.
 */
export function isEvaluableExternal(path: string, rules: InlineRules): boolean {
  return !/\.(?:node|wasm)$/.test(path) && isThirdParty(path, rules)
}
