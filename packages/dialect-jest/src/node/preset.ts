// T11.5: Jest 30.5's preset resolution and merge, `jest-config` `normalize.ts` L148-L260. A
// relative or absolute preset is used as it is; a name `x` resolves `x/jest-preset` with the
// extensions `.json .js .cjs .mjs` from `rootDir`. It is loaded afresh each time (Jest deletes it
// from `require.cache`, so each project of a multi-project run sees its own copy). Merge:
// `setupFiles` and `setupFilesAfterEnv` (when the config has them) and `modulePathIgnorePatterns`
// (when both have it) concatenate, preset first; `moduleNameMapper` and `transform` merge with the
// config's keys first in iteration order (`{...config, ...preset, ...config}`); `globals`
// deep-merge (`deepmerge` 4); everything else is the config's over the preset's.
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { ConfigError } from '@provino/config'
import { JestConfigError, messageOf } from './errors.ts'
import { requireOrImportModule } from './load.ts'
import { replaceRootDirInPath } from './paths.ts'
import type { JestResolution } from './resolution.ts'
import { CONFIG_ERROR_TITLE, DOCUMENTATION_NOTE, validationText } from './text.ts'

const PRESET_EXTENSIONS: readonly string[] = ['.json', '.js', '.cjs', '.mjs']
const PRESET_NAME = 'jest-preset'

type Options = Record<string, unknown>

function configError(message: string, cause?: unknown): JestConfigError {
  return new JestConfigError(
    'JEST_CONFIG_PRESET',
    validationText(CONFIG_ERROR_TITLE, message, DOCUMENTATION_NOTE),
    cause === undefined ? undefined : { cause },
  )
}

function isMergeableObject(value: unknown): value is Readonly<Record<string, unknown>> {
  // deepmerge 4's `is-mergeable-object`: a non-null object that isn't a RegExp or a Date (or a
  // React element).
  if (typeof value !== 'object' || value === null) return false
  const tag = Object.prototype.toString.call(value)
  if (tag === '[object RegExp]' || tag === '[object Date]') return false
  return Reflect.get(value, '$$typeof') !== Symbol.for('react.element')
}

function cloneUnlessOtherwise(value: unknown): unknown {
  return isMergeableObject(value) ? deepMerge(Array.isArray(value) ? [] : {}, value) : value
}

function keysOf(value: object): (string | symbol)[] {
  return [
    ...Object.keys(value),
    ...Object.getOwnPropertySymbols(value).filter((symbol) =>
      Object.prototype.propertyIsEnumerable.call(value, symbol),
    ),
  ]
}

function isOn(object: unknown, key: string | symbol): boolean {
  try {
    return typeof object === 'object' && object !== null && key in object
  } catch {
    return false
  }
}

/**
 * `deepmerge` 4.3.1 (`dist/cjs.js`) with its defaults: arrays concatenate (target's, then
 * source's), objects merge key by key (own enumerable keys and symbols; a key the target has only
 * through its prototype, or as a non-enumerable one, is skipped), and everything is cloned.
 */
export function deepMerge(target: unknown, source: unknown): unknown {
  const sourceIsArray = Array.isArray(source)
  if (sourceIsArray !== Array.isArray(target)) return cloneUnlessOtherwise(source)
  if (sourceIsArray && Array.isArray(target)) {
    return [...target, ...source].map((item: unknown) => cloneUnlessOtherwise(item))
  }
  const out: Record<string | symbol, unknown> = {}
  if (isMergeableObject(target)) {
    for (const key of keysOf(target)) out[key] = cloneUnlessOtherwise(Reflect.get(target, key))
  }
  if (typeof source !== 'object' || source === null) return out
  for (const key of keysOf(source)) {
    const unsafe =
      isOn(target, key) &&
      !(
        Object.hasOwn(target as object, key) &&
        Object.prototype.propertyIsEnumerable.call(target, key)
      )
    if (unsafe) continue
    const value: unknown = Reflect.get(source, key)
    out[key] =
      isOn(target, key) && isMergeableObject(value)
        ? deepMerge(Reflect.get(target as object, key), value)
        : cloneUnlessOtherwise(value)
  }
  return out
}

async function loadPreset(path: string): Promise<unknown> {
  if (path.endsWith('.json')) {
    // `require` of a `.json` file: `JSON.parse`, comments not allowed.
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  try {
    // Jest `require`s a preset (`requireOrImportModule`): a module with only named exports is its
    // namespace, and an `.mjs` one with no default export fails as Jest's does.
    return await requireOrImportModule(path)
  } catch (error) {
    throw error instanceof ConfigError && error.cause !== undefined ? error.cause : error
  }
}

/**
 * Loads `optionsPreset` for a config and merges it in, as Jest's `setupPreset` does. `options`
 * has its `rootDir` and `setupFiles` already (`normalizeMissingOptions`). Throws `JestConfigError`
 * (`JEST_CONFIG_PRESET`) with Jest's text when the preset can't be found or loaded.
 * @public
 */
export async function setupPreset(
  options: Readonly<Options> & { readonly rootDir: string },
  optionsPreset: string,
  resolution: JestResolution,
): Promise<Options> {
  const presetPath = replaceRootDirInPath(options.rootDir, optionsPreset)
  const presetModule = resolution.findNodeModule(
    presetPath.startsWith('.') || isAbsolute(presetPath)
      ? presetPath
      : `${presetPath}/${PRESET_NAME}`,
    { basedir: options.rootDir, extensions: PRESET_EXTENSIONS },
  )
  let preset: unknown
  try {
    if (!presetModule) throw new Error(`Cannot find module '${presetPath}'`)
    preset = await loadPreset(presetModule)
  } catch (error) {
    const message = messageOf(error)
    const stack = error instanceof Error ? error.stack : undefined
    // L198-L237
    if (error instanceof SyntaxError || error instanceof TypeError) {
      throw configError(`  Preset ${presetPath} is invalid:\n\n  ${message}\n  ${stack}`, error)
    }
    if (message.includes('Cannot find module')) {
      if (message.includes(presetPath)) {
        const bare = resolution.findNodeModule(presetPath, { basedir: options.rootDir })
        if (bare) {
          throw configError(
            `  Module ${presetPath} should have "jest-preset.js" or "jest-preset.json" file at the root.`,
            error,
          )
        }
        throw configError(
          `  Preset ${presetPath} not found relative to rootDir ${options.rootDir}.`,
          error,
        )
      }
      throw configError(`  Missing dependency in ${presetPath}:\n\n  ${message}\n  ${stack}`, error)
    }
    throw configError(
      `  An unknown error occurred in ${presetPath}:\n\n  ${message}\n  ${stack}`,
      error,
    )
  }
  const loaded: Readonly<Options> =
    typeof preset === 'object' && preset !== null ? (preset as Readonly<Options>) : {}
  const merged: Options = { ...options }
  const array = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : [])
  // L240-L257
  if (merged.setupFiles) {
    merged.setupFiles = [...array(loaded.setupFiles || []), ...array(merged.setupFiles)]
  }
  if (merged.setupFilesAfterEnv) {
    merged.setupFilesAfterEnv = [
      ...array(loaded.setupFilesAfterEnv || []),
      ...array(merged.setupFilesAfterEnv),
    ]
  }
  if (merged.modulePathIgnorePatterns && loaded.modulePathIgnorePatterns) {
    merged.modulePathIgnorePatterns = [
      ...array(loaded.modulePathIgnorePatterns),
      ...array(merged.modulePathIgnorePatterns),
    ]
  }
  for (const key of ['moduleNameMapper', 'transform'] as const) {
    const own = merged[key]
    const fromPreset = loaded[key]
    if (own && fromPreset) {
      merged[key] = {
        ...(own as object),
        ...(fromPreset as object),
        ...(own as object),
      }
    }
  }
  if (merged.globals && loaded.globals) {
    merged.globals = deepMerge(loaded.globals, merged.globals)
  }
  return { ...loaded, ...merged }
}
