// Shape checks for values the worker did not make: the project config that crossed a link, and
// what a module the project supplied by ref exports or returns.

/**
 * Whether `value` is an object that is not an array.
 * @internal
 */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether `value` is an array of strings.
 * @internal
 */
export function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}
