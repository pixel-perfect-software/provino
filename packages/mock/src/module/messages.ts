// The module registry's message codes. As with `internal/messages.ts`, a code belongs to this
// package and its text belongs to the dialect's `ModulePolicy.messages`; the text here is the
// neutral policy's, used for any code a policy doesn't list. `{word}` is filled in.
import type { ModulePolicy } from '@provino/types'
import { fill } from '../internal/messages.ts'

const NEUTRAL_MODULE_MESSAGES = {
  // `{specifier}`, `{from}` (the importer, relative to the first root).
  'module-missing':
    "Cannot find module '{specifier}' from '{from}'. To mock a module that does not exist on disk, pass the `virtual` option",
  // The same for an unmock: jest-resolve's own text, with no `virtual` hint (an unmock has no such option).
  'unmock-module-missing': "Cannot find module '{specifier}' from '{from}'",
  // A namespace-shaped factory returned a non-object. `{raw}` is the specifier as written.
  'factory-not-object': 'The mock factory for "{raw}" must return an object',
  // Reading `{name}` from the mock of `{raw}` under `missingFactoryExport: 'throw'`.
  'missing-factory-export': 'No "{name}" export is defined on the "{raw}" mock',
  // `{caller}` and `{other}` name the two isolation calls.
  'nested-isolation': '{caller} cannot be nested inside another {caller} or {other}',
  // Automock found nothing it could describe. `{id}` is the module.
  'automock-no-metadata': 'Failed to get mock metadata: {id}',
  // A factory asked for the module it is building. `{raw}` is the specifier as written.
  'circular-mock': 'The mock factory for "{raw}" imports the module it mocks',
  'registry-disposed': 'The module mock registry was disposed',
  // Importing a mocked relative path that is not on disk under `virtualRelative: false`. `{id}` is
  // the path from the root, with a leading `/`.
  'unresolved-relative-mock': "Cannot find module '{id}'",
} as const

/**
 * The codes `ModulePolicy.messages` is keyed by.
 * @public
 */
export type ModuleMessageCode = keyof typeof NEUTRAL_MODULE_MESSAGES

/** Fills a code's text from the policy, or from the neutral table. */
export function moduleMessage(
  policy: ModulePolicy,
  code: ModuleMessageCode,
  values: Readonly<Record<string, string>>,
): string {
  return fill(policy.messages[code] ?? NEUTRAL_MODULE_MESSAGES[code], values)
}
