// Narrowing helpers for data that arrives as `unknown` (parsed JSON, fields the runners' own
// types don't declare), and the few small helpers every module shares. Nothing here casts: a value
// is checked, then it is typed.
import { readFile } from 'node:fs/promises'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a file-system error says the path does not exist. */
export function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

/** The text of a file, or `undefined` if it does not exist. Any other failure is thrown. */
export async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch (cause) {
    if (isNotFound(cause)) return undefined
    throw cause
  }
}

/** The text of a caught value: an `Error`'s message, else the value as a string. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Reads one property from an object whose type doesn't declare it. */
export function prop(source: object, key: string): unknown {
  return Reflect.get(source, key)
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Code-point order, so output never depends on the machine's locale. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Orders anything with a `file` by it, in code-point order. */
export function byFile(a: { readonly file: string }, b: { readonly file: string }): number {
  return compareStrings(a.file, b.file)
}

/** A `YYYY-MM-DD` date's shape. Whether the date exists is the caller's check. */
export const ISO_DATE: RegExp = /^\d{4}-\d{2}-\d{2}$/

/** The date a command works on: its `--today`, else the current UTC date, as `YYYY-MM-DD`. */
export function today(
  command: { readonly today?: string },
  now: () => Date = () => new Date(),
): string {
  return command.today ?? now().toISOString().slice(0, 10)
}

/** The text with every regular-expression metacharacter escaped, for building a pattern. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
