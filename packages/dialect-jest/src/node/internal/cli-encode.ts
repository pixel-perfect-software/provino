// A JSON-safe, comparable form of a parsed `argv` (T11.7 tests): `undefined`, `NaN` and the
// infinities survive a trip through JSON as markers, so the oracle's child process and the test
// compare the same shapes with `deepStrictEqual`.

/** Marker objects for the values JSON can't carry. */
export function encodeForCompare(value: unknown): unknown {
  if (value === undefined) return { $undefined: true }
  if (typeof value === 'number' && !Number.isFinite(value)) return { $number: String(value) }
  if (typeof value === 'function') return { $function: value.toString() }
  if (Array.isArray(value)) return value.map((item: unknown) => encodeForCompare(item))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      out[key] = encodeForCompare(Reflect.get(value, key))
    }
    return out
  }
  return value
}
