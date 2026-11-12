// A test file's docblock pragmas (`@jest-environment jsdom`, `@jest-environment-options {...}`),
// read in the worker before the environment is chosen (R4). Only the leading block comment counts,
// as jest-docblock's `extract` takes it; a pragma is `@name value` on one line, and a repeated one
// becomes a list.
import { readFile } from 'node:fs/promises'

/** The leading block comment's text, or `''`: `extract` in jest-docblock. */
function leadingComment(source: string): string {
  const match = /^\s*(\/\*\*?(.|\r?\n)*?\*\/)/.exec(source)
  return match?.[1] ?? ''
}

/**
 * The pragmas of a file's docblock, by name without the `@`. A pragma with no value is `''`.
 * @internal
 */
export function parsePragmas(source: string): Record<string, string | readonly string[]> {
  const pragmas: Record<string, string | readonly string[]> = {}
  for (const line of leadingComment(source).split(/\r?\n/)) {
    const match = /^\s*(?:\/\*+|\*)?\s*@([A-Za-z][\w-]*)[ \t]*(.*?)\s*(?:\*\/)?\s*$/.exec(line)
    if (match === null) continue
    const [, name, value] = match
    if (name === undefined || value === undefined) continue
    const earlier = pragmas[name]
    pragmas[name] =
      earlier === undefined
        ? value
        : typeof earlier === 'string'
          ? [earlier, value]
          : [...earlier, value]
  }
  return pragmas
}

/**
 * Reads `file`'s docblock pragmas. A file that can't be read has none: the runner's own import
 * reports it.
 * @internal
 */
export async function readPragmas(
  file: string,
): Promise<Record<string, string | readonly string[]>> {
  try {
    return parsePragmas(await readFile(file, 'utf8'))
  } catch {
    return {}
  }
}

/** The last value of a pragma (a repeated one: the last wins, as jest-runner's does), or `undefined`. */
export function pragmaValue(
  pragmas: Readonly<Record<string, string | readonly string[]>>,
  name: string,
): string | undefined {
  const value = pragmas[name]
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : value.at(-1)
}
