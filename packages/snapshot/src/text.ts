// The text rules of a `.snap` file, the same in both dialects: how a snapshot is escaped into a
// template literal and how a multi-line one is padded. Jest 30.5.2 (`@jest/snapshot-utils`
// `utils.ts`, `jest-snapshot` `utils.ts`) and Vitest 5.0.5 (`snapshot/src/port/utils.ts`) agree
// on all of it.

/**
 * Escapes a snapshot for a template literal: a backtick, a backslash and `${`.
 * @public
 */
export const escapeBacktickString = (text: string): string => text.replaceAll(/`|\\|\$\{/g, '\\$&')

/**
 * A snapshot as the template literal a `.snap` file holds.
 * @public
 */
export const printBacktickString = (text: string): string => `\`${escapeBacktickString(text)}\``

/**
 * `\r\n` and `\r` become `\n`.
 * @public
 */
export const normalizeNewlines = (text: string): string => text.replaceAll(/\r\n|\r/g, '\n')

/**
 * Pads a multi-line snapshot with a line break at each end, so the file reads easier.
 * @public
 */
export const addExtraLineBreaks = (text: string): string =>
  text.includes('\n') ? `\n${text}\n` : text

/**
 * Takes the padding off again. Not `trim`, which would also eat blank lines and spaces a custom
 * serializer meant.
 * @public
 */
export const removeExtraLineBreaks = (text: string): string =>
  text.length > 2 && text.startsWith('\n') && text.endsWith('\n') ? text.slice(1, -1) : text
