// Narrowing helpers for data that arrives as `unknown` (parsed JSON, fields the runners' own
// types don't declare). Nothing here casts: a value is checked, then it is typed.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
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
