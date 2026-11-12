// The loader's own message codes, read from `ModulePolicy.messages` like the module-mock
// registry's (B13c Gap 4): a dialect's text overrides the neutral one, and a code with no neutral
// text does nothing unless the dialect gives one. Neutral code never asks which runner it is.
import type { ModulePolicy } from '@provino/types'

/**
 * - `transform-failed`: a file's transform reported an error. `{file}` is its path, `{where}` the
 *   `:line:column` of the error (empty when it has none), `{message}` the error's text. A code
 *   frame, when there is one, follows after a blank line.
 * - `module-not-found`: an import or `require` whose specifier doesn't resolve, and that no mock
 *   stands in for. `{specifier}` as written, `{importer}` the importing file, `{from}` that file
 *   relative to the loader's root (`/` separators).
 * - `mapper-miss`: a name-mapper rule matched but none of its targets resolved. `{specifier}` as
 *   written, `{rule}` the rule's regular expression as text, `{target}` what the targets resolved
 *   to (the configured target when there is one, else the list, as JSON), `{declared}` the targets
 *   as configured (one, or the list indented to nest in a config object) and `{resolver}` the
 *   custom resolver (`undefined` when none). No neutral text: the miss is a `module-not-found`
 *   unless the dialect gives one.
 * - `unresolved-mock-import`: loading a test file failed on a mock that can't stand in for a
 *   relative path (`unresolved-relative-mock`). `{message}` is that error's text, `{importer}` the
 *   test file. No neutral text: the error is as thrown unless the dialect gives one.
 */
export type LoaderMessageCode =
  | 'transform-failed'
  | 'module-not-found'
  | 'mapper-miss'
  | 'unresolved-mock-import'

const NEUTRAL: Readonly<Partial<Record<LoaderMessageCode, string>>> = {
  'transform-failed': '{file}{where}: {message}',
  'module-not-found': "Cannot find module '{specifier}' imported from {importer}",
}

/** The text for `code`, filled with `values`, or `undefined` when neither the policy nor the neutral set has one. */
export function loaderMessage(
  policy: ModulePolicy,
  code: LoaderMessageCode,
  values: Readonly<Record<string, string>>,
): string | undefined {
  const template = policy.messages[code] ?? NEUTRAL[code]
  if (template === undefined) return undefined
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.hasOwn(values, key) ? (values[key] ?? '') : whole,
  )
}
