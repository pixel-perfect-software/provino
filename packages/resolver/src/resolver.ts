// T3.2: the resolver core over oxc-resolver (Track 3 R3). Dialect mappers run first, then one
// shared-cache `ResolverFactory` clone per condition list. Jest's `modulePaths` retry and custom
// `resolver` module are T3.3's, so they are rejected here rather than ignored.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { findPackageJSON } from 'node:module'
import { dirname } from 'node:path'
import type {
  CreateResolver,
  ResolveContext,
  ResolveKind,
  ResolveResult,
  Resolver,
  ResolverOptions,
} from '@provino/types'
import { type NapiResolveOptions, ResolverFactory } from 'oxc-resolver'
import { ResolverError } from './errors.ts'

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
  if (options.modulePaths !== undefined) {
    throw new ResolverError(
      'RESOLVER_OPTION_UNSUPPORTED',
      '`modulePaths` is not supported yet (T3.3 adds the retry).',
    )
  }
  if (options.custom !== undefined) {
    throw new ResolverError(
      'RESOLVER_OPTION_UNSUPPORTED',
      'A custom Jest `resolver` module is not supported yet (T3.3 adds the adapter).',
    )
  }

  const base = baseOptions(options)
  const useResolveFile = base.tsconfig !== undefined
  const root = new ResolverFactory(base)
  // One clone per condition list; clones share the root's file-system cache.
  const byConditions = new Map<string, ResolverFactory>()

  function factoryFor(conditions: readonly string[]): ResolverFactory {
    const key = conditions.join('\0')
    let factory = byConditions.get(key)
    if (factory === undefined) {
      factory = root.cloneWithOptions({ ...base, conditionNames: [...conditions] })
      byConditions.set(key, factory)
    }
    return factory
  }

  function resolveDirect(specifier: string, context: ResolveContext): ResolveResult {
    const conditions = [...new Set([...context.conditions, kindCondition(context.kind)])]
    const factory = factoryFor(conditions)
    const result = useResolveFile
      ? factory.resolveFileSync(context.importer, specifier)
      : factory.sync(dirname(context.importer), specifier)
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

  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        resolver: oxcResolverVersion(),
        base,
        mappers: options.mappers.map((mapper) => mapper.id),
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
