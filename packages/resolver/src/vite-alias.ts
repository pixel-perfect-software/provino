// T3.3, B25c: Vite's `resolve.alias` (and Vitest's `test.alias`) as a `ModuleMapper`. Vite hands the
// entries to @rollup/plugin-alias, whose rule is: a string `find` matches the importee when it is
// equal to it or starts with it followed by `/`; a RegExp `find` matches when it tests true; the
// first matching entry in order decides, and the new id is `importee.replace(find, replacement)`
// (so `$1`, `$&` and the other replacement patterns apply, a string `find` replaces its first
// occurrence, which is the prefix). The replaced id then resolves like any specifier; one that does
// not resolve is the import's failure (plugin-alias passes the replaced id on and nothing else
// finds it), which is `onMiss: 'error'`.
import type { JsonValue, ModuleMapper, ModuleMapperFactory } from '@provino/types'
import { ResolverError } from './errors.ts'

/**
 * One alias entry as JSON: a string `find`, or a RegExp as its source and flags.
 * @public
 */
export interface ViteAliasEntry {
  readonly find: string | { readonly source: string; readonly flags: string }
  readonly replacement: string
}

/**
 * What `viteAliasMapper` is called with.
 * @public
 */
export interface ViteAliasOptions {
  readonly aliases: readonly ViteAliasEntry[]
}

function isEntry(value: unknown): value is ViteAliasEntry {
  if (typeof value !== 'object' || value === null) return false
  const find: unknown = Reflect.get(value, 'find')
  const replacement: unknown = Reflect.get(value, 'replacement')
  if (typeof replacement !== 'string') return false
  if (typeof find === 'string') return true
  if (typeof find !== 'object' || find === null) return false
  return (
    typeof Reflect.get(find, 'source') === 'string' &&
    typeof Reflect.get(find, 'flags') === 'string'
  )
}

function readOptions(options: JsonValue): ViteAliasOptions {
  const aliases: unknown =
    typeof options === 'object' && options !== null && !Array.isArray(options)
      ? Reflect.get(options, 'aliases')
      : undefined
  if (!Array.isArray(aliases) || !aliases.every(isEntry)) {
    throw new ResolverError(
      'RESOLVER_BAD_MAPPER',
      "the Vite alias mapper's `aliases` must be a list of { find, replacement }",
    )
  }
  return { aliases }
}

/**
 * Builds the mapper for a list of Vite alias entries, in Vite's order.
 * @public
 */
export function createViteAliasMapper(options: ViteAliasOptions): ModuleMapper {
  const compiled = options.aliases.map((entry) => {
    if (typeof entry.find === 'string') return { entry, find: entry.find, test: null }
    try {
      const find = new RegExp(entry.find.source, entry.find.flags)
      // `test` on a global or sticky RegExp moves `lastIndex`; the replace keeps the flags.
      const test = new RegExp(entry.find.source, entry.find.flags.replace(/[gy]/g, ''))
      return { entry, find, test }
    } catch (cause) {
      throw new ResolverError(
        'RESOLVER_BAD_MAPPER',
        `the Vite alias ${JSON.stringify(entry.find)} is not a regular expression`,
        { cause },
      )
    }
  })
  return {
    id: `vite-alias:${JSON.stringify(options.aliases)}`,
    map(specifier) {
      for (const { entry, find, test } of compiled) {
        const hit =
          test === null
            ? typeof find === 'string' && (specifier === find || specifier.startsWith(`${find}/`))
            : test.test(specifier)
        if (!hit) continue
        return {
          candidates: [specifier.replace(find, entry.replacement)],
          onMiss: 'error',
          rule: String(find),
          declared: [entry.replacement],
        }
      }
      return null
    },
  }
}

/**
 * `ModuleMapperFactory` form of `createViteAliasMapper`, for a `ModuleRef`.
 * @public
 */
export const viteAliasMapper: ModuleMapperFactory = (options) =>
  createViteAliasMapper(readOptions(options))
