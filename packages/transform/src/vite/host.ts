// The Vite plugin host (T3.9, B25 Phase 4): a project's plugins' build-style hooks (`buildStart`,
// `resolveId`, `load`, `transform`) run in a worker, with a plugin context that carries what real
// plugins read (`parse`, `resolve`, `warn`, `error`, `addWatchFile`, `getCombinedSourcemap`,
// `environment`). The dev server's hooks have no meaning in a test run: see `UNSUPPORTED_*`.
import { createHash } from 'node:crypto'
import type { SourceMapV3 } from '@provino/types'
import { parseSync } from 'oxc-parser'
import { composeMaps, toSourceMapV3 } from '../internal/maps.ts'
import { ViteHostError } from './errors.ts'
import { type FilterValue, type HookFilter, passesFilter } from './filter.ts'

/** A hook: the function, or Vite's object form with a `filter` that keeps it from running. */
export type VitePluginHook<F> =
  | F
  | {
      readonly handler: F
      readonly filter?: HookFilter
      readonly order?: 'pre' | 'post' | null
    }

type AnyHook = (this: VitePluginContext, ...args: never[]) => unknown

/**
 * A Vite plugin, as far as the host reads it. Every hook is optional; the result types are
 * `unknown` because plugins return a string, an object or nothing, and the host checks them.
 * @public
 */
export interface VitePlugin {
  readonly name: string
  readonly enforce?: 'pre' | 'post'
  readonly buildStart?: VitePluginHook<AnyHook>
  readonly resolveId?: VitePluginHook<AnyHook>
  readonly load?: VitePluginHook<AnyHook>
  readonly transform?: VitePluginHook<AnyHook>
  /** Dev-server hooks: never called. `strict` makes their presence an error. */
  readonly configureServer?: unknown
  readonly handleHotUpdate?: unknown
  readonly transformIndexHtml?: unknown
}

/**
 * The hooks that need a dev server or the module graph: a plugin that has one is not an error (Vue
 * defines two), but `strict` hosts refuse it, and the context's members below throw when called.
 * @public
 */
export const UNSUPPORTED_PLUGIN_HOOKS: readonly (keyof VitePlugin)[] = [
  'configureServer',
  'handleHotUpdate',
  'transformIndexHtml',
]

/** Context members that need the module graph or a bundle. */
const UNSUPPORTED_CONTEXT_MEMBERS: ReadonlySet<string> = new Set([
  'getModuleInfo',
  'getModuleIds',
  'emitFile',
  'getFileName',
  'setAssetSource',
  'load',
])

/**
 * What a hook sees as `this`.
 * @public
 */
export interface VitePluginContext {
  parse(code: string, options?: { readonly allowReturnOutsideFunction?: boolean }): unknown
  resolve(
    source: string,
    importer?: string,
    options?: { readonly skipSelf?: boolean; readonly isEntry?: boolean },
  ): Promise<{ readonly id: string; readonly external: boolean } | null>
  warn(message: string | { readonly message: string }): void
  error(message: string | { readonly message: string }): never
  addWatchFile(file: string): void
  getCombinedSourcemap(): SourceMapV3
  readonly environment: {
    readonly name: 'ssr'
    readonly mode: 'dev'
    readonly config: { readonly consumer: 'server' }
  }
  readonly meta: {
    readonly rollupVersion: string
    /** Set because Vite 8's plugin context is Rolldown's: plugins use it to pick `transformWithOxc`. */
    readonly rolldownVersion: string
    readonly watchMode: false
  }
}

/**
 * What a plugin's `resolveId` led to, in the resolver's terms: a file the resolver can read, or a
 * module only the host can load (a `\0` id, a bare id, an id with a query: `/a.vue?vue&type=style`).
 * @public
 */
export type ViteResolvedId =
  | { readonly type: 'file'; readonly path: string }
  | { readonly type: 'virtual'; readonly id: string; readonly owner: 'vite-host' }
  | { readonly type: 'external'; readonly id: string }

/**
 * What `load` and `transform` produced.
 * @public
 */
export interface ViteSource {
  readonly code: string
  readonly map: SourceMapV3 | null
}

/**
 * What the cache fingerprint holds of one plugin: its name, the version of its package when it
 * could be found, and a hash of its hooks' code.
 * @public
 */
export interface VitePluginIdentity {
  readonly name: string
  readonly version: string | null
  readonly codeHash: string
}

/**
 * Options for `createViteHost`.
 * @public
 */
export interface ViteHostOptions {
  readonly root: string
  readonly plugins: readonly VitePlugin[]
  /** `@vitejs/plugin-react` is skipped unless this is `true`: Oxc already does JSX. */
  readonly includeReact?: boolean
  /** Refuse a plugin that has a dev-server hook. */
  readonly strict?: boolean
  readonly warn?: (message: string) => void
  /**
   * What `this.resolve` falls back to when no plugin resolves a specifier: the project's resolver,
   * where Vite has its own. Plugins like vite-tsconfig-paths map a path and ask the context to
   * finish resolving it (extensions, `index` files). Return the id, or `null`.
   */
  readonly resolve?: (
    source: string,
    importer: string | undefined,
  ) => string | null | Promise<string | null>
}

/**
 * The plugin host.
 * @public
 */
export interface ViteHost {
  /** Names of the plugins that run, in hook order (`pre`, normal, `post`). */
  readonly pluginNames: readonly string[]
  /** Names of the plugins left out (`@vitejs/plugin-react`'s). */
  readonly skipped: readonly string[]
  readonly watchFiles: ReadonlySet<string>
  readonly warnings: readonly string[]
  buildStart(): Promise<void>
  resolveId(source: string, importer: string | undefined): Promise<ViteResolvedId | null>
  load(id: string): Promise<ViteSource | null>
  /** `null` when no plugin changed the code. */
  transform(code: string, id: string): Promise<ViteSource | null>
}

const REACT_PLUGIN = /^vite:react/
const HOOK_NAMES = ['config', 'configResolved', 'buildStart', 'resolveId', 'load', 'transform']

function handlerOf(hook: unknown): AnyHook | null {
  if (typeof hook === 'function') return hook as AnyHook
  if (typeof hook === 'object' && hook !== null && 'handler' in hook) {
    const handler = (hook as { readonly handler: unknown }).handler
    return typeof handler === 'function' ? (handler as AnyHook) : null
  }
  return null
}

function filterOf(hook: unknown): HookFilter | undefined {
  if (typeof hook === 'object' && hook !== null && 'filter' in hook) {
    return (hook as { readonly filter?: HookFilter }).filter
  }
  return undefined
}

function messageOf(value: string | { readonly message: string }): string {
  return typeof value === 'string' ? value : value.message
}

function isAbsolute(id: string): boolean {
  return id.startsWith('/') || /^[A-Za-z]:[\\/]/.test(id)
}

/** The resolver's view of an id a plugin returned. */
export function classifyViteId(id: string, external: boolean): ViteResolvedId {
  if (external) return { type: 'external', id }
  if (id.startsWith('\0') || !isAbsolute(id) || id.includes('?')) {
    return { type: 'virtual', id, owner: 'vite-host' }
  }
  return { type: 'file', path: id }
}

function sourceMapOf(value: unknown): SourceMapV3 | null {
  let map: unknown = value
  if (typeof map === 'string') {
    try {
      map = JSON.parse(map)
    } catch {
      return null
    }
  }
  if (typeof map !== 'object' || map === null) return null
  const record = map as { readonly mappings?: unknown; readonly sources?: unknown }
  if (typeof record.mappings !== 'string' || !Array.isArray(record.sources)) return null
  return toSourceMapV3(map as SourceMapV3)
}

function sourceOf(result: unknown): { code: string; map: SourceMapV3 | null } | null {
  if (typeof result === 'string') return { code: result, map: null }
  if (typeof result === 'object' && result !== null && 'code' in result) {
    const { code, map } = result as { readonly code: unknown; readonly map?: unknown }
    if (typeof code === 'string') return { code, map: sourceMapOf(map) }
  }
  return null
}

/**
 * The part of the cache fingerprint a plugin list contributes: names, versions, hook code and the
 * config file's hash, so a plugin update or a config edit misses the transform cache. The
 * coordinator computes it from the bridge's identities, with no plugin objects.
 * @public
 */
export function viteHostFingerprint(
  identities: readonly VitePluginIdentity[],
  configHash: string | null,
): string {
  const hash = createHash('sha256')
  hash.update(`config:${configHash ?? ''}\0`)
  for (const { name, version, codeHash } of identities) {
    hash.update(`${name}\0${version ?? ''}\0${codeHash}\0`)
  }
  return hash.digest('hex')
}

/** A hash of every hook a plugin defines, by the text of its function. */
export function pluginCodeHash(plugin: VitePlugin): string {
  const hash = createHash('sha256')
  for (const hook of HOOK_NAMES) {
    const handler = handlerOf((plugin as unknown as Record<string, unknown>)[hook])
    if (handler !== null) hash.update(`${hook}\0${handler.toString()}\0`)
  }
  return hash.digest('hex')
}

/**
 * Creates the host. Plugins are ordered as Vite orders them: `enforce: 'pre'`, the rest, then
 * `enforce: 'post'`. A plugin's `apply`, `config` and `configResolved` already ran in the bridge.
 * @public
 */
export function createViteHost(options: ViteHostOptions): ViteHost {
  const { plugins, includeReact = false, strict = false } = options
  const skipped: string[] = []
  const kept = plugins.filter((plugin) => {
    if (!includeReact && REACT_PLUGIN.test(plugin.name)) {
      skipped.push(plugin.name)
      return false
    }
    return true
  })
  if (strict) {
    for (const plugin of kept) {
      for (const hook of UNSUPPORTED_PLUGIN_HOOKS) {
        if (plugin[hook] !== undefined) {
          throw new ViteHostError(
            'VITE_HOOK_UNSUPPORTED',
            plugin.name,
            `the Vite plugin "${plugin.name}" has a \`${hook}\` hook, which needs a dev server; Provino runs build-style hooks only (buildStart, resolveId, load, transform)`,
          )
        }
      }
    }
  }
  const ordered = [
    ...kept.filter((plugin) => plugin.enforce === 'pre'),
    ...kept.filter((plugin) => plugin.enforce === undefined),
    ...kept.filter((plugin) => plugin.enforce === 'post'),
  ]
  const watchFiles = new Set<string>()
  const warnings: string[] = []
  const warn = (plugin: string, message: string): void => {
    const text = `[${plugin}] ${message}`
    warnings.push(text)
    options.warn?.(text)
  }

  const contextFor = (
    plugin: VitePlugin,
    hook: string,
    currentMap: () => SourceMapV3,
  ): VitePluginContext => {
    const fail = (message: string, cause?: unknown): never => {
      throw new ViteHostError(
        'VITE_PLUGIN_FAILED',
        plugin.name,
        `the Vite plugin "${plugin.name}" failed in \`${hook}\`: ${message}`,
        cause === undefined ? undefined : { cause },
      )
    }
    const context: VitePluginContext = {
      parse: (code) => {
        const result = parseSync('parse.js', code, { sourceType: 'module' })
        const first = result.errors[0]
        if (first !== undefined) return fail(first.message)
        return result.program
      },
      resolve: async (source, importer, resolveOptions) =>
        resolveChain(source, importer, resolveOptions?.skipSelf === true ? plugin : null, true),
      warn: (message) => warn(plugin.name, messageOf(message)),
      error: (message) => fail(messageOf(message)),
      addWatchFile: (file) => {
        watchFiles.add(file)
      },
      getCombinedSourcemap: currentMap,
      environment: { name: 'ssr', mode: 'dev', config: { consumer: 'server' } },
      meta: { rollupVersion: '4.0.0', rolldownVersion: '1.0.0', watchMode: false },
    }
    return new Proxy(context, {
      get(target, key, receiver) {
        if (typeof key === 'string' && UNSUPPORTED_CONTEXT_MEMBERS.has(key)) {
          throw new ViteHostError(
            'VITE_HOOK_UNSUPPORTED',
            plugin.name,
            `the Vite plugin "${plugin.name}" called \`this.${key}\` in \`${hook}\`, which needs the module graph or a bundle; Provino's Vite host doesn't have one`,
          )
        }
        return Reflect.get(target, key, receiver)
      },
    })
  }

  const identityMap = (id: string): SourceMapV3 => ({
    version: 3,
    sources: [id],
    names: [],
    mappings: '',
  })

  async function call(
    plugin: VitePlugin,
    hook: 'buildStart' | 'resolveId' | 'load' | 'transform',
    args: readonly unknown[],
    currentMap: () => SourceMapV3,
  ): Promise<unknown> {
    const handler = handlerOf(plugin[hook])
    if (handler === null) return undefined
    try {
      return await (handler as (this: VitePluginContext, ...rest: unknown[]) => unknown).call(
        contextFor(plugin, hook, currentMap),
        ...args,
      )
    } catch (error) {
      if (error instanceof ViteHostError) throw error
      throw new ViteHostError(
        'VITE_PLUGIN_FAILED',
        plugin.name,
        `the Vite plugin "${plugin.name}" failed in \`${hook}\`: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }

  async function resolveChain(
    source: string,
    importer: string | undefined,
    skip: VitePlugin | null,
    fallback = false,
  ): Promise<{ readonly id: string; readonly external: boolean } | null> {
    const found = await resolveByPlugins(source, importer, skip)
    if (found !== null || !fallback || options.resolve === undefined) return found
    const id = await options.resolve(source, importer)
    return id === null ? null : { id, external: false }
  }

  async function resolveByPlugins(
    source: string,
    importer: string | undefined,
    skip: VitePlugin | null,
  ): Promise<{ readonly id: string; readonly external: boolean } | null> {
    for (const plugin of ordered) {
      if (plugin === skip) continue
      const hook = plugin.resolveId
      if (handlerOf(hook) === null || !passesFilter(filterOf(hook)?.id, source)) continue
      const result = await call(
        plugin,
        'resolveId',
        [source, importer, { ssr: true, isEntry: false, attributes: {}, custom: {} }],
        () => identityMap(source),
      )
      if (typeof result === 'string') return { id: result, external: false }
      if (typeof result === 'object' && result !== null && 'id' in result) {
        const { id, external } = result as { readonly id: unknown; readonly external?: unknown }
        if (typeof id === 'string') return { id, external: external === true }
      }
    }
    return null
  }

  let started: Promise<void> | null = null

  return {
    pluginNames: ordered.map((plugin) => plugin.name),
    skipped,
    watchFiles,
    warnings,
    buildStart: () => {
      started ??= (async () => {
        for (const plugin of ordered) {
          await call(plugin, 'buildStart', [{}], () => identityMap(''))
        }
      })()
      return started
    },
    resolveId: async (source, importer) => {
      const found = await resolveChain(source, importer, null)
      return found === null ? null : classifyViteId(found.id, found.external)
    },
    load: async (id) => {
      for (const plugin of ordered) {
        const hook = plugin.load
        if (handlerOf(hook) === null || !passesFilter(filterOf(hook)?.id, id)) continue
        const result = await call(plugin, 'load', [id, { ssr: true }], () => identityMap(id))
        const source = sourceOf(result)
        if (source !== null) return source
      }
      return null
    },
    transform: async (code, id) => {
      let current = code
      const maps: (SourceMapV3 | null)[] = []
      let changed = false
      for (const plugin of ordered) {
        const hook = plugin.transform
        if (handlerOf(hook) === null) continue
        const filter = filterOf(hook)
        if (!passesFilter(filter?.id, id) || !passesFilter(filter?.code as FilterValue, current)) {
          continue
        }
        const result = await call(plugin, 'transform', [current, id, { ssr: true }], () => {
          return composeMaps(maps) ?? identityMap(id)
        })
        const source = sourceOf(result)
        if (source === null) continue
        changed = changed || source.code !== current || source.map !== null
        current = source.code
        maps.push(source.map)
      }
      return changed ? { code: current, map: composeMaps(maps) } : null
    },
  }
}
