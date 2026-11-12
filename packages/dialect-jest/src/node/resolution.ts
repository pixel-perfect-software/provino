// How the Jest config reader finds the modules a config names, as `jest-config` 30.5.2 does:
// `Resolver.findNodeModule` (`jest-resolve` `resolver.ts` L131-L172: `unrs-resolver`, a fork of
// oxc-resolver, with conditions `require`, `node`, `default`, extensions `.js .json .node` unless
// given, real paths, or the project's custom `resolver` module), and `require.resolve` from
// jest-config's own install for the packages Jest ships (`babel-jest`, `jest-environment-node`,
// `jest-circus/runner`, `jest-runner`, `@jest/test-sequencer`). Ours resolves through
// `@provino/resolver` (oxc-resolver) with the same options.
import { isBuiltin } from 'node:module'
import { join } from 'node:path'
import { ConfigError, importConfigModule } from '@provino/config'
import { createResolver } from '@provino/resolver'
import type { Resolver } from '@provino/types'
import { type JestRequireResolve, projectJestRequireResolve } from '../jest-require.ts'
import { JestConfigError, messageOf } from './errors.ts'

export { type JestRequireResolve, projectJestRequireResolve }

/** What Jest passes a custom resolver (`jest-resolve` `defaultResolver.ts` L22-L50). */
interface JestResolverCallOptions {
  readonly basedir: string
  readonly conditions?: readonly string[] | undefined
  readonly extensions?: readonly string[] | undefined
  readonly moduleDirectory?: readonly string[] | undefined
  readonly paths?: readonly string[] | undefined
  readonly rootDir?: string | undefined
  readonly defaultResolver: (path: string, options: JestResolverCallOptions) => string
  readonly defaultAsyncResolver: (path: string, options: JestResolverCallOptions) => Promise<string>
}

type SyncResolver = (path: string, options: JestResolverCallOptions) => unknown

/** `findNodeModule`'s options. */
export interface FindNodeModuleOptions {
  readonly basedir: string
  readonly extensions?: readonly string[] | undefined
  /** The project's custom `resolver` module (absolute), preloaded. */
  readonly resolver?: string | null | undefined
}

/**
 * Module resolution as `jest-config` sees it.
 * @public
 */
export interface JestResolution {
  /** `Resolver.findNodeModule`: the resolved path, or `null` on a miss. */
  findNodeModule(path: string, options: FindNodeModuleOptions): string | null
  /**
   * `require.resolve` from jest-config's own install: where Jest's built-in packages come from.
   * `undefined` when no Jest install is known or it can't resolve the name.
   */
  requireResolve(specifier: string): string | undefined
  /** `preloadResolver`: loads a custom resolver module before resolution uses it. */
  preloadResolver(path: string): Promise<void>
}

const DEFAULT_EXTENSIONS: readonly string[] = ['.js', '.json', '.node']
/** Neutralises `@provino/resolver`'s `.js` → `.ts` aliasing, which Jest's resolver doesn't do. */
const NO_EXTENSION_ALIAS: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.js'],
  '.mjs': ['.mjs'],
  '.cjs': ['.cjs'],
}

/** A custom resolver module as `asResolver`/`toResolver` (L1065-L1113) accept it. */
function asResolver(loaded: unknown): SyncResolver | { readonly sync?: unknown } | null {
  if (typeof loaded === 'function') return loaded as SyncResolver
  if (typeof loaded === 'object' && loaded !== null) {
    if (Reflect.get(loaded, 'sync') != null || Reflect.get(loaded, 'async') != null) {
      return loaded as { readonly sync?: unknown }
    }
  }
  return null
}

/**
 * Builds the resolution a normalize run uses. `requireResolve` is where Jest's built-in packages
 * come from (see `JestRequireResolve`).
 * @public
 */
export function createJestResolution(requireResolve: JestRequireResolve): JestResolution {
  const resolvers = new Map<string, Resolver>()
  const custom = new Map<string, SyncResolver | { readonly sync?: unknown }>()

  const resolverFor = (extensions: readonly string[], moduleDirectories?: readonly string[]) => {
    const key = JSON.stringify([extensions, moduleDirectories ?? null])
    let resolver = resolvers.get(key)
    if (resolver === undefined) {
      resolver = createResolver({
        root: '/',
        mappers: [],
        extensions,
        extensionAlias: NO_EXTENSION_ALIAS,
        tsconfig: false,
        ...(moduleDirectories === undefined ? {} : { moduleDirectories }),
      })
      resolvers.set(key, resolver)
    }
    return resolver
  }

  /** `baseResolver` (`defaultResolver.ts` L126-L248) for one request. */
  const base = (
    path: string,
    basedir: string,
    extensions: readonly string[] | undefined,
    conditions: readonly string[] | undefined,
    moduleDirectories: readonly string[] | undefined,
  ): string | null => {
    if (isBuiltin(path)) return path
    const result = resolverFor(extensions ?? DEFAULT_EXTENSIONS, moduleDirectories).resolve(path, {
      importer: join(basedir, '__provino_jest_config__.js'),
      kind: 'require',
      // `kind: 'require'` adds `require`, so the default is Jest's `require`, `node`, `default`.
      conditions: conditions ?? ['node', 'default'],
    })
    if (result.type === 'file') return result.path
    if (result.type === 'builtin') return path
    return null
  }

  const defaultResolver = (path: string, options: JestResolverCallOptions): string => {
    const found = base(
      path,
      options.basedir,
      options.extensions,
      options.conditions,
      options.moduleDirectory,
    )
    if (found === null) throw new Error(`Cannot find module '${path}' from '${options.basedir}'`)
    return found
  }

  return {
    findNodeModule(path, options) {
      const loaded = options.resolver == null ? undefined : custom.get(options.resolver)
      let resolve: SyncResolver | undefined
      if (typeof loaded === 'function') resolve = loaded
      else if (loaded !== undefined && typeof loaded.sync === 'function') {
        resolve = loaded.sync as SyncResolver
      }
      if (resolve === undefined) {
        return base(path, options.basedir, options.extensions, undefined, undefined)
      }
      try {
        const found = resolve(path, {
          basedir: options.basedir,
          conditions: undefined,
          defaultAsyncResolver: async (request, callOptions) =>
            defaultResolver(request, callOptions),
          defaultResolver,
          extensions: options.extensions,
          moduleDirectory: undefined,
          paths: undefined,
          rootDir: undefined,
        })
        return typeof found === 'string' ? found : null
      } catch {
        return null
      }
    },
    requireResolve,
    async preloadResolver(path) {
      if (custom.has(path)) return
      let loaded: unknown
      try {
        // Loaded once. A module with no default export is its namespace, so named `sync`/`async`
        // exports make a resolver, as `toResolver` (L1084-L1113) accepts them.
        loaded = await importConfigModule(path, { withoutDefault: 'namespace' })
      } catch (error) {
        throw new JestConfigError(
          'JEST_CONFIG_LOAD_FAILED',
          `can't load the resolver "${path}": ${messageOf(error instanceof ConfigError ? error.cause : error)}`,
          { cause: error },
        )
      }
      const resolver = asResolver(loaded)
      if (resolver === null) {
        throw new JestConfigError(
          'JEST_CONFIG_LOAD_FAILED',
          `Resolver located at ${path} does not export a function or an object with "sync" and "async" props`,
        )
      }
      custom.set(path, resolver)
    },
  }
}
