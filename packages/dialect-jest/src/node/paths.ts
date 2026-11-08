// Jest 30.5's path and pattern helpers, rebuilt from their sources: `jest-config` `utils.ts`
// (`replaceRootDirInPath`, `_replaceRootDirTags`, `escapeGlobCharacters`), `jest-regex-util`
// (`replacePathSepForRegex`), `jest-util` (`replacePathSepForGlob`, `tryRealpath`) and
// `jest-config` `constants.ts` / `Defaults.ts` (`NODE_MODULES_REGEXP`).
import { realpathSync } from 'node:fs'
import { normalize, resolve, sep } from 'node:path'

/**
 * `<rootDir>` at the start of a path, replaced by `rootDir` (`utils.ts` L60-L71). A path without it
 * is returned as it is.
 * @public
 */
export function replaceRootDirInPath(rootDir: string, filePath: string): string {
  if (!filePath.startsWith('<rootDir>')) return filePath
  return resolve(rootDir, normalize(`./${filePath.slice('<rootDir>'.length)}`))
}

/**
 * `_replaceRootDirTags` (`utils.ts` L73-L112): every string in a value (arrays and plain objects
 * walked; a `rootDir` key and a `RegExp` kept) with `<rootDir>` replaced.
 */
export function replaceRootDirTags(rootDir: string, value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return replaceRootDirInPath(rootDir, value)
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item: unknown) => replaceRootDirTags(rootDir, item))
  if (value instanceof RegExp) return value
  const out: Record<string, unknown> = {}
  // `for…in`, as upstream: inherited enumerable keys are copied too.
  for (const key in value) {
    const item: unknown = Reflect.get(value, key)
    out[key] = key === 'rootDir' ? item : replaceRootDirTags(rootDir, item)
  }
  return out
}

/** `escapeGlobCharacters` (`utils.ts` L57-L58). */
export function escapeGlobCharacters(path: string): string {
  return path.replaceAll(/([!()*?[\\\]{}])/g, '\\$1')
}

/** `jest-util` `replacePathSepForGlob`: backslashes not escaping a glob character become `/`. */
export function replacePathSepForGlob(path: string): string {
  return path.replaceAll(/\\(?![$()+.?^{}])/g, '/')
}

/** `jest-regex-util` `replacePathSepForRegex`: a no-op where the separator is `/`. */
export function replacePathSepForRegex(value: string): string {
  if (sep === '\\') {
    return value.replaceAll(/(\/|(.)?\\(?![$()*+.?[\\\]^{|}]))/g, (_match, _first, p2?: string) =>
      p2 && p2 !== '\\' ? `${p2}\\\\` : '\\\\',
    )
  }
  return value
}

/** `jest-util` `tryRealpath`: the real path, or the path itself when it doesn't exist. */
export function tryRealpath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch (error) {
    const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : undefined
    if (code !== 'ENOENT' && code !== 'EISDIR') throw error
    return path
  }
}

/** `constants.ts` L10 through `replacePathSepForRegex`: `/node_modules/` on POSIX. */
export const NODE_MODULES_REGEXP: string = replacePathSepForRegex(`${sep}node_modules${sep}`)
