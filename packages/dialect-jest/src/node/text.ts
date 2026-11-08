// The pieces of jest-config 30.5.2's and jest-validate 30.5.1's messages that users compare
// against, copied from those packages' sources (`.claude/rules/dialects.md`), without chalk's
// colours: Jest prints them plain when the stream isn't a colour terminal, which is how they are
// compared. Each constant names its source file and line.

/** jest-config `utils.ts` L20 (`chalk.bold('\u25CF ')`). */
export const CONFIG_BULLET = '\u25CF '

/** jest-config `utils.ts` L21-L25. */
export const DOCUMENTATION_NOTE = `  Configuration Documentation:
  https://jestjs.io/docs/configuration
`

/** jest-validate `utils.ts` L13-L16 (`chalk.bold('\u25CF')`, then a space in each title). */
export const VALIDATE_BULLET = '\u25CF'
export const DEPRECATION_TITLE: string = `${VALIDATE_BULLET} Deprecation Warning`
export const VALIDATE_ERROR_TITLE: string = `${VALIDATE_BULLET} Validation Error`
export const WARNING_TITLE: string = `${VALIDATE_BULLET} Validation Warning`

/** jest-config `normalize.ts` L62: the title of every error `createConfigError` builds. */
export const CONFIG_ERROR_TITLE: string = `${CONFIG_BULLET}Validation Error`

/**
 * The text of a jest-validate `ValidationError` (`utils.ts` L29-L40): `name`, a blank line, the
 * message, then the comment after another blank line (or one newline when there is none).
 */
export function validationText(name: string, message: string, comment?: string | null): string {
  const tail = comment ? `\n\n${comment}` : '\n'
  return `${name}:\n\n${message}${tail}`
}

/**
 * The text jest-validate's `logValidationWarning` prints (`utils.ts` L42-L49): the same shape as
 * an error's.
 */
export function warningText(name: string, message: string, comment?: string | null): string {
  return validationText(name, message, comment)
}

/** Levenshtein distance, as `leven` 3 computes it (insertions, deletions, substitutions). */
export function leven(left: string, right: string): number {
  if (left === right) return 0
  if (left.length === 0) return right.length
  if (right.length === 0) return left.length
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i++) {
    const current = [i]
    for (let j = 1; j <= right.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1)
      const insertion = (current[j - 1] ?? 0) + 1
      const deletion = (previous[j] ?? 0) + 1
      current.push(Math.min(substitution, insertion, deletion))
    }
    previous = current
  }
  return previous[right.length] ?? 0
}

/**
 * jest-validate's `createDidYouMeanMessage` (`utils.ts` L51-L62): the first allowed option fewer
 * than 3 edits away, or `''`.
 */
export function didYouMean(unrecognized: string, allowed: readonly string[]): string {
  const suggestion = allowed.find((option) => leven(option, unrecognized) < 3)
  return suggestion === undefined ? '' : `Did you mean ${formatValue(suggestion)}?`
}

/**
 * jest-validate's `format` (`utils.ts` L18-L21): a function's source, else `pretty-format` with
 * `{ min: true }`. The pretty-format part covers what config values hold: primitives, arrays,
 * plain objects (keys sorted, as pretty-format sorts them), class instances, `RegExp`, `Date`,
 * errors, `Map`, `Set`, nested functions and cycles.
 */
export function formatValue(value: unknown): string {
  return typeof value === 'function' ? value.toString() : printMin(value, [])
}

function printString(value: string): string {
  return `"${value.replaceAll(/["\\]/g, '\\$&')}"`
}

function printNumber(value: number): string {
  return Object.is(value, -0) ? '-0' : String(value)
}

function functionName(value: { readonly name?: unknown }): string {
  return typeof value.name === 'string' && value.name !== '' ? value.name : 'anonymous'
}

function printPrimitive(value: unknown): string | undefined {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'undefined':
      return 'undefined'
    case 'boolean':
      return String(value)
    case 'number':
      return printNumber(value)
    case 'bigint':
      return `${String(value)}n`
    case 'string':
      return printString(value)
    case 'symbol':
      return String(value)
    case 'function':
      return `[Function ${functionName(value)}]`
    default:
      return undefined
  }
}

function printMin(value: unknown, seen: readonly object[]): string {
  const primitive = printPrimitive(value)
  if (primitive !== undefined) return primitive
  const object = value as object
  if (object instanceof RegExp) return String(object)
  if (object instanceof Date) {
    return Number.isNaN(object.getTime()) ? 'Date { NaN }' : object.toISOString()
  }
  if (object instanceof Error) return `[${object.toString()}]`
  if (seen.includes(object)) return '[Circular]'
  const inner = [...seen, object]
  if (Array.isArray(object)) {
    return `[${object.map((item: unknown) => printMin(item, inner)).join(', ')}]`
  }
  if (object instanceof Map) {
    const entries = [...object.entries()].map(
      ([key, item]: [unknown, unknown]) => `${printMin(key, inner)} => ${printMin(item, inner)}`,
    )
    return `Map {${entries.join(', ')}}`
  }
  if (object instanceof Set) {
    return `Set {${[...object].map((item: unknown) => printMin(item, inner)).join(', ')}}`
  }
  const record = object as Readonly<Record<string, unknown>>
  const keys = Object.keys(record).sort()
  const symbols = Object.getOwnPropertySymbols(record).filter(
    (symbol) => Object.getOwnPropertyDescriptor(record, symbol)?.enumerable === true,
  )
  const parts = [
    ...keys.map((key) => `${printString(key)}: ${printMin(record[key], inner)}`),
    ...symbols.map(
      (symbol) => `${String(symbol)}: ${printMin(Reflect.get(record, symbol), inner)}`,
    ),
  ]
  return `{${parts.join(', ')}}`
}
