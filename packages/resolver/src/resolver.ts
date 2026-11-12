// T3.2: the resolver core over oxc-resolver (Track 3 R3). Dialect mappers run first, then one
// shared-cache `ResolverFactory` clone per condition list. T3.3 adds Jest's `modulePaths` retry
// (absolute directories searched after the `node_modules` walk-up misses) and the custom
// `resolver` module, called with Jest's `(path, { basedir, ... })` shape.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { builtinModules, findPackageJSON } from 'node:module'
import { dirname, extname, join } from 'node:path'
import type {
  CreateResolver,
  JestResolverOptions,
  ResolveContext,
  ResolveKind,
  ResolveResult,
  Resolver,
  ResolverOptions,
} from '@provino/types'
import { type NapiResolveOptions, ResolverFactory } from 'oxc-resolver'

/** R3's default: `.js` imports find `.ts`/`.tsx` sources first. */
const DEFAULT_EXTENSION_ALIAS: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx', '.js'],
  '.mjs': ['.mts', '.mjs'],
  '.cjs': ['.cts', '.cjs'],
}

type FileFormat = Extract<ResolveResult, { type: 'file' }>['format']

const FORMATS: Readonly<Record<string, FileFormat>> = {
  module: 'esm',
  commonjs: 'cjs',
  json: 'json',
  wasm: 'wasm',
  addon: 'addon',
}

/** The condition a call kind adds. A mock specifier resolves like an import until T4.7 decides. */
function kindCondition(kind: ResolveKind): string {
  return kind === 'require' ? 'require' : 'import'
}

function isNodeId(id: string): id is `node:${string}` {
  return id.startsWith('node:')
}

function oxcResolverVersion(): string {
  const path = findPackageJSON('oxc-resolver', import.meta.url)
  if (path === undefined) return 'unknown'
  const pkg: { readonly version?: unknown } = JSON.parse(readFileSync(path, 'utf8'))
  return typeof pkg.version === 'string' ? pkg.version : 'unknown'
}

function baseOptions(options: ResolverOptions): NapiResolveOptions {
  const tsconfig = options.tsconfig ?? 'auto'
  const extensionAlias: Record<string, string[]> = {}
  for (const [ext, targets] of Object.entries({
    ...DEFAULT_EXTENSION_ALIAS,
    ...options.extensionAlias,
  })) {
    extensionAlias[ext] = [...targets]
  }
  const base: NapiResolveOptions = {
    extensions: [...options.extensions],
    extensionAlias,
    builtinModules: true,
    moduleType: true,
    // Node's ESM resolution ignores NODE_PATH.
    nodePath: false,
    symlinks: options.symlinks ?? true,
    modules: [...(options.moduleDirectories ?? ['node_modules'])],
    aliasFields: options.browserField === true ? ['browser'] : [],
  }
  if (tsconfig === 'auto') base.tsconfig = 'auto'
  else if (tsconfig !== false) {
    base.tsconfig = {
      configFile: tsconfig.configFile,
      ...(tsconfig.references === undefined ? {} : { references: tsconfig.references }),
    }
  }
  if (options.mainFields !== undefined) base.mainFields = [...options.mainFields]
  if (options.roots !== undefined) base.roots = [...options.roots]
  return base
}

/**
 * Creates a resolver. Resolution order: the mappers, in order (the first hit wins), then
 * oxc-resolver with the context's conditions plus the call kind's (`require` or `import`).
 * @public
 */
export const createResolver: CreateResolver = (options) => {
  const base = baseOptions(options)
  const useResolveFile = base.tsconfig !== undefined
  const root = new ResolverFactory(base)
  // Jest's `modulePaths` are searched after the walk-up: a retry whose lookup directories add them.
  const modulePaths = options.modulePaths ?? []
  const retryBase: NapiResolveOptions | null =
    modulePaths.length === 0
      ? null
      : { ...base, modules: [...(base.modules ?? []), ...modulePaths] }
  const retryRoot = retryBase === null ? null : root.cloneWithOptions(retryBase)
  // One clone per condition list; clones share the root's file-system cache.
  const byConditions = new Map<string, ResolverFactory>()
  const retryByConditions = new Map<string, ResolverFactory>()

  function factoryFor(conditions: readonly string[], retry = false): ResolverFactory {
    const key = conditions.join('\0')
    const cache = retry ? retryByConditions : byConditions
    let factory = cache.get(key)
    if (factory === undefined) {
      const from = retry && retryRoot !== null ? retryRoot : root
      factory = from.cloneWithOptions({
        ...(retry ? retryBase : base),
        conditionNames: [...conditions],
      })
      cache.set(key, factory)
    }
    return factory
  }

  function resolveWith(
    factory: ResolverFactory,
    specifier: string,
    context: ResolveContext,
  ): ReturnType<ResolverFactory['sync']> {
    return useResolveFile
      ? factory.resolveFileSync(context.importer, specifier)
      : factory.sync(dirname(context.importer), specifier)
  }

  function resolveDirect(specifier: string, context: ResolveContext): ResolveResult {
    const conditions = [...new Set([...context.conditions, kindCondition(context.kind)])]
    let result = resolveWith(factoryFor(conditions), specifier, context)
    if (result.path === undefined && result.builtin === undefined && retryRoot !== null) {
      result = resolveWith(factoryFor(conditions, true), specifier, context)
    }
    if (result.builtin !== undefined && isNodeId(result.builtin.resolved)) {
      return { type: 'builtin', id: result.builtin.resolved }
    }
    if (result.path !== undefined) {
      const moduleType: string | undefined = result.moduleType
      return {
        type: 'file',
        path: result.path,
        format: (moduleType === undefined ? undefined : FORMATS[moduleType]) ?? 'unknown',
        packageJson: result.packageJsonPath ?? null,
        mappedBy: null,
      }
    }
    return {
      type: 'not-found',
      specifier,
      importer: context.importer,
      tried: [],
      mappedBy: null,
    }
  }

  /** `custom` as a sync function: Jest's `toSyncResolver` (a function, or the object's `sync`). */
  const custom = options.custom
  const customSync =
    custom === undefined ? null : typeof custom === 'function' ? custom : (custom.sync ?? null)

  function fileResult(path: string): ResolveResult {
    const ext = extname(path)
    const format: FileFormat =
      ext === '.json' ? 'json' : ext === '.mjs' ? 'esm' : ext === '.cjs' ? 'cjs' : 'unknown'
    return { type: 'file', path, format, packageJson: null, mappedBy: null }
  }

  /**
   * Jest's custom `resolver`, called as `findNodeModule` calls it (`resolver.ts`): a throw is a
   * miss, a string is the answer. `defaultResolver` is our own resolution from `basedir`.
   */
  function resolveCustom(
    run: NonNullable<typeof customSync>,
    specifier: string,
    context: ResolveContext,
  ): ResolveResult {
    const conditions = [...new Set([...context.conditions, kindCondition(context.kind)])]
    const defaultResolver = (path: string, callOptions: JestResolverOptions): string => {
      const result = resolveDirect(path, {
        importer: join(callOptions.basedir, '__provino_resolve__.js'),
        kind: context.kind,
        conditions: callOptions.conditions ?? conditions,
      })
      if (result.type === 'file') return result.path
      if (result.type === 'builtin') return path
      throw new Error(`Cannot find module '${path}' from '${callOptions.basedir}'`)
    }
    let found: unknown
    try {
      found = run(specifier, {
        basedir: dirname(context.importer),
        conditions,
        defaultResolver,
        extensions: options.extensions,
        moduleDirectory: options.moduleDirectories ?? ['node_modules'],
        ...(options.modulePaths === undefined ? {} : { paths: options.modulePaths }),
        rootDir: options.root,
      })
    } catch {
      found = undefined
    }
    if (typeof found !== 'string' || found === '') {
      return { type: 'not-found', specifier, importer: context.importer, tried: [], mappedBy: null }
    }
    const bare = found.startsWith('node:') ? found.slice(5) : found
    if (builtinModules.includes(bare)) return { type: 'builtin', id: `node:${bare}` }
    return fileResult(found)
  }

  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        resolver: oxcResolverVersion(),
        base,
        mappers: options.mappers.map((mapper) => mapper.id),
        modulePaths,
        custom: custom === undefined ? null : String(customSync ?? custom),
      }),
    )
    .digest('hex')

  const resolver: Resolver = {
    resolve(specifier, context) {
      for (const mapper of options.mappers) {
        const hit = mapper.map(specifier, context)
        if (hit === null) continue
        for (const candidate of hit.candidates) {
          const result = resolveDirect(candidate, context)
          if (result.type === 'file') return { ...result, mappedBy: hit.rule }
          if (result.type !== 'not-found') return result
        }
        if (hit.onMiss === 'error') {
          return {
            type: 'not-found',
            specifier,
            importer: context.importer,
            tried: [...hit.candidates],
            mappedBy: hit.rule,
          }
        }
        // `continue`: the first hit still wins, so later mappers are skipped.
        break
      }
      if (customSync !== null) return resolveCustom(customSync, specifier, context)
      return resolveDirect(specifier, context)
    },
    invalidate() {
      // oxc-resolver can only clear its whole cache, which every clone shares.
      root.clearCache()
    },
    fingerprint,
  }
  return resolver
}
