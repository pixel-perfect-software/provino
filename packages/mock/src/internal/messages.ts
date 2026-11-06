// The message codes (B13a Gap 8). A code belongs to this package; its text belongs to the dialect's
// `MockPolicy.messages`, so a dialect's words are exact. The text here is the neutral policy's,
// used for any code a policy doesn't list. `{key}`, `{type}` and `{name}` are filled in.
import type { MockPolicy } from '@provino/types'

const NEUTRAL_MESSAGES = {
  // `spyInstall: 'assign'`.
  'spy-primitive': 'Cannot spy on a primitive value; {type} given',
  'spy-no-key': 'No property name supplied',
  'spy-missing': 'Property `{key}` does not exist in the provided object',
  'spy-not-a-function': 'Cannot spy on `{key}` because it is not a function; {type} given',
  'spy-not-a-function-primitive':
    'Cannot spy on `{key}` because it is not a function; {type} given. To mock a property, use replaceProperty',
  'spy-not-configurable': 'Property `{key}` is not declared configurable',
  'spy-no-access-type': 'Property `{key}` does not have access type {type}',
  // `spyInstall: 'define'`.
  'spy-nullish': 'Cannot spy on nothing: the first argument must be defined',
  'spy-define-primitive': 'Cannot spy on a primitive value',
  'spy-define-missing': 'The property "{key}" is not defined on the {type}',
  'spy-define-not-a-function': 'Can only spy on a function. Received {type}',
  'spy-namespace': 'Cannot spy on export "{key}". A module namespace is not configurable in ESM',
  // `replaceProperty`.
  'replace-primitive': 'Cannot replace a property of a primitive value; {type} given',
  'replace-no-key': 'No property name supplied',
  'replace-missing': 'Property `{key}` does not exist in the provided object',
  'replace-not-configurable': 'Property `{key}` is not declared configurable',
  'replace-getter': 'Cannot replace `{key}` because it has a getter. Spy on its getter instead',
  'replace-setter': 'Cannot replace `{key}` because it has a setter. Spy on its setter instead',
  'replace-function': 'Cannot replace `{key}` because it is a function. Spy on it instead',
  // `valueShorthandsThrowOnNew`.
  'new-shorthand':
    'Cannot use `{name}` when called with `new`. Use `mockImplementation` with a `class` instead',
} as const

/**
 * The codes `MockPolicy.messages` is keyed by. A policy may also set two with no neutral text, so
 * they do nothing unless it does: `new-not-a-constructor` warns when `new` runs an implementation
 * that can't construct (`{name}` is the mock's name), and `spy-read-only` replaces V8's text for a
 * spy assigned to a read-only property (`{key}`, `{tag}`).
 * @internal
 */
export type MockMessageCode = keyof typeof NEUTRAL_MESSAGES

/** Fills a code's text from the policy, or from the neutral table. */
export function messageFor(
  policy: MockPolicy,
  code: MockMessageCode,
  values: Readonly<Record<string, string>>,
): string {
  const text = policy.messages[code] ?? NEUTRAL_MESSAGES[code]
  return fill(text, values)
}

/** Replaces `{word}` with its value; a `{word}` with no value stays. */
export function fill(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{(\w+)\}/g, (whole, word: string) => values[word] ?? whole)
}
