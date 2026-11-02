// String helpers shared by the manifest, workspace and generator modules.

/**
 * Escapes RegExp syntax in a literal path or name.
 * @public
 */
export function escapeRegex(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

/**
 * A manifest name or dir as a RegExp source. `*` matches one path segment
 * (`packages/native-*` matches `packages/native-linux-x64`, not `packages/native-a/b`).
 * @public
 */
export function wildcardSource(text: string): string {
  return text.split('*').map(escapeRegex).join('[^/]+')
}

/**
 * Whether a manifest name or dir (with `*`) matches a whole value.
 * @public
 */
export function matches(pattern: string, value: string): boolean {
  return new RegExp(`^${wildcardSource(pattern)}$`).test(value)
}

/**
 * Compares strings by code unit, so sorted output never depends on the locale.
 * @public
 */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
