// T3.3: Jest's `moduleNameMapper` as a `ModuleMapper`. Rebuilt from jest-resolve 30.5.2's
// `resolveStubModuleName` (`resolver.ts` L881-L941) and `_getMapModuleName` (L528-L536): the rules
// run in order against the specifier as written, the first regex that matches decides, `$n` in a
// target is that capture group (an unmatched group is `''`), and once a rule matches its targets
// must resolve or the lookup is an error that names the rule.
import type { JsonValue, ModuleMapper, ModuleMapperFactory } from '@provino/types'
import { ResolverError } from './errors.ts'

/**
 * One rule: a regular expression's source and the targets in order.
 * @public
 */
export interface NameMapperRule {
  readonly pattern: string
  readonly targets: readonly string[]
}

/**
 * What `jestModuleNameMapper` is called with (JSON, so a worker can load it by `ModuleRef`).
 * @public
 */
export interface NameMapperOptions {
  /** Replaces `<rootDir>` in a target. Jest's own normalize already does; a neutral config may not. */
  readonly rootDir?: string
  readonly rules: readonly NameMapperRule[]
}

const ROOT_DIR = /<rootDir>/g

function isRule(value: unknown): value is NameMapperRule {
  if (typeof value !== 'object' || value === null) return false
  const pattern: unknown = Reflect.get(value, 'pattern')
  const targets: unknown = Reflect.get(value, 'targets')
  return (
    typeof pattern === 'string' &&
    Array.isArray(targets) &&
    targets.every((target) => typeof target === 'string')
  )
}

/** Narrows the JSON a mapper factory gets; a wrong shape is a coded error, not a crash later. */
function readOptions(options: JsonValue): NameMapperOptions {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new ResolverError('RESOLVER_BAD_MAPPER', 'the name mapper needs an object of options')
  }
  const rules: unknown = Reflect.get(options, 'rules')
  if (!Array.isArray(rules) || !rules.every(isRule)) {
    throw new ResolverError(
      'RESOLVER_BAD_MAPPER',
      "the name mapper's `rules` must be a list of { pattern, targets }",
    )
  }
  const rootDir: unknown = Reflect.get(options, 'rootDir')
  return {
    ...(typeof rootDir === 'string' ? { rootDir } : {}),
    rules,
  }
}

/**
 * Builds the mapper for `moduleNameMapper`. A `$n` in a target takes the n-th capture group of the
 * rule's match; the replacement is Jest's `replaceAll(/\$(\d+)/g, ...)`.
 * @public
 */
export function createNameMapper(options: NameMapperOptions): ModuleMapper {
  const compiled = options.rules.map((rule) => {
    let regex: RegExp
    try {
      regex = new RegExp(rule.pattern)
    } catch (cause) {
      throw new ResolverError(
        'RESOLVER_BAD_MAPPER',
        `the name mapper's pattern ${JSON.stringify(rule.pattern)} is not a regular expression`,
        { cause },
      )
    }
    const targets = rule.targets.map((target) =>
      options.rootDir === undefined ? target : target.replace(ROOT_DIR, options.rootDir),
    )
    return { regex, targets }
  })
  return {
    id: `name-mapper:${JSON.stringify(options.rules)}`,
    map(specifier) {
      for (const { regex, targets } of compiled) {
        const matches = specifier.match(regex)
        if (matches === null) continue
        return {
          candidates: targets.map((target) =>
            target.replaceAll(
              /\$(\d+)/g,
              (_, index: string) => matches[Number.parseInt(index, 10)] || '',
            ),
          ),
          onMiss: 'error',
          rule: regex.toString(),
          declared: targets,
        }
      }
      return null
    },
  }
}

/**
 * `ModuleMapperFactory` form of `createNameMapper`, for a `ModuleRef`.
 * @public
 */
export const jestModuleNameMapper: ModuleMapperFactory = (options) =>
  createNameMapper(readOptions(options))
