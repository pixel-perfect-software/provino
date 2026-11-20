// The Vite bridge (B25 Phase 4, T11.15's bridge, D169): when a config has plugins, the project's own
// `vitest/node` `resolveConfig` runs them (their `config` and `configResolved` hooks can change
// `test`) and this module reads what it gives back. Vite is the project's, never ours (D172): it is
// imported from the project's root, and a project without it gets one warning and no plugins.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The JSX settings Vite's `oxc` (Vite 8) or `esbuild` option carries, as the pipeline's
 * `PipelineJsxOptions` reads them.
 * @public
 */
export interface ViteJsxSettings {
  readonly runtime: 'automatic' | 'classic'
  readonly importSource?: string
  readonly development?: boolean
}

/**
 * What the cache fingerprint holds of one user plugin (the transform package's
 * `VitePluginIdentity`, structurally).
 * @public
 */
export interface ViteBridgePlugin {
  readonly name: string
  readonly version: string | null
  readonly codeHash: string
}

/**
 * What the bridge read. Clone-safe: plugins themselves can't cross threads (NN4), so a worker
 * imports the config again through `loadViteBridge`.
 * @public
 */
export interface ViteBridgeResult {
  /** `resolveConfig(...).test`, after every plugin's `config` hook. */
  readonly test: Readonly<Record<string, unknown>>
  readonly jsx: ViteJsxSettings | null
  /**
   * `define` as Vitest 5.0.5 applies it: not a text replacement. A plain-identifier key with a JSON
   * value becomes a global in the worker (`defines`, `test.defines`); a key with a dot, or a value
   * that is code (`"process.env.VAR"`), is evaluated there (`scriptDefines`, `test._scriptDefines`);
   * `process.env.X` and `import.meta.env.X` keys were already set on `process.env` by
   * `resolveConfig`. The worker wires them (B25f); the pipeline's own `define` stays unset.
   */
  readonly defines: Readonly<Record<string, unknown>>
  readonly scriptDefines: Readonly<Record<string, string>>
  readonly resolveConditions: readonly string[]
  /** The user's plugins, in Vite's hook order: Vite's and Vitest's own are left out. */
  readonly plugins: readonly ViteBridgePlugin[]
  /** A hash of the config file's text, or `null` when there is no file. */
  readonly configHash: string | null
  readonly warnings: readonly string[]
}

/**
 * The bridge's options.
 * @public
 */
export interface ViteBridgeOptions {
  readonly root: string
  /** The config file, or `false` for none. */
  readonly configFile: string | false
  readonly mode: string
  /** Command-line options, as `resolveConfig`'s first argument takes them. */
  readonly cliOptions?: Readonly<Record<string, unknown>>
}

/**
 * The bridge's result with the live plugin objects, which stay in the process that called it.
 * @public
 */
export interface LoadedViteBridge {
  readonly result: ViteBridgeResult
  readonly plugins: readonly unknown[]
}

type Rec = Record<string, unknown>

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `oxc.jsx` (Vite 8) or `esbuild.jsx*` (earlier) to the pipeline's JSX options. */
export function viteJsxSettings(viteConfig: Rec): ViteJsxSettings | null {
  const oxc = viteConfig.oxc
  if (isRec(oxc) && isRec(oxc.jsx)) {
    const { runtime, importSource, development } = oxc.jsx
    if (runtime === 'automatic' || runtime === 'classic') {
      return {
        runtime,
        ...(typeof importSource === 'string' ? { importSource } : {}),
        ...(typeof development === 'boolean' ? { development } : {}),
      }
    }
  }
  const esbuild = viteConfig.esbuild
  if (isRec(esbuild)) {
    const { jsx, jsxImportSource, jsxDev } = esbuild
    if (jsx === 'automatic' || jsx === 'transform') {
      return {
        runtime: jsx === 'automatic' ? 'automatic' : 'classic',
        ...(typeof jsxImportSource === 'string' ? { importSource: jsxImportSource } : {}),
        ...(typeof jsxDev === 'boolean' ? { development: jsxDev } : {}),
      }
    }
  }
  return null
}

function scriptDefinesOf(test: unknown): Readonly<Record<string, string>> {
  const defines = isRec(test) ? test._scriptDefines : undefined
  if (!isRec(defines)) return {}
  return Object.fromEntries(
    Object.entries(defines).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

function hookText(plugin: Rec, hook: string): string | null {
  const value = plugin[hook]
  if (typeof value === 'function') return value.toString()
  if (isRec(value) && typeof value.handler === 'function') return value.handler.toString()
  return null
}

const HASHED_HOOKS = ['config', 'configResolved', 'buildStart', 'resolveId', 'load', 'transform']

function codeHashOf(plugin: Rec): string {
  const hash = createHash('sha256')
  for (const hook of HASHED_HOOKS) {
    const text = hookText(plugin, hook)
    if (text !== null) hash.update(`${hook}\0${text}\0`)
  }
  return hash.digest('hex')
}

/** The version of the package a plugin name points at, tried as the name and as the usual prefixes. */
function versionOf(root: string, name: string): string | null {
  const bare = name.replace(/^vite:/, '')
  const candidates = [name, `@vitejs/plugin-${bare}`, `vite-plugin-${bare}`, `vite-${bare}`]
  const require = createRequire(join(root, 'noop.js'))
  for (const candidate of candidates) {
    try {
      const path = require.resolve(`${candidate}/package.json`)
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (isRec(parsed) && typeof parsed.version === 'string') return parsed.version
    } catch {
      // not that package: try the next name
    }
  }
  return null
}

/** The file `vitest/node` resolves to from `root`, through its `exports` (`import` condition). */
function resolveVitestNode(root: string): string {
  const require = createRequire(join(root, 'noop.js'))
  const manifestPath = require.resolve('vitest/package.json')
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  let target: unknown =
    isRec(manifest) && isRec(manifest.exports) ? manifest.exports['./node'] : null
  while (isRec(target)) target = target.import ?? target.default
  if (typeof target !== 'string') throw new Error("vitest's package.json has no './node' export")
  return join(manifestPath, '..', target)
}

type ResolveConfig = (options: Rec, viteOverrides?: Rec) => Promise<Rec>

async function importResolveConfig(root: string): Promise<ResolveConfig> {
  const module: unknown = await import(pathToFileURL(resolveVitestNode(root)).href)
  const resolveConfig = isRec(module) ? module.resolveConfig : undefined
  if (typeof resolveConfig !== 'function') throw new Error("vitest/node has no 'resolveConfig'")
  return resolveConfig as ResolveConfig
}

function pluginsOf(config: Rec): Rec[] {
  return Array.isArray(config.plugins) ? config.plugins.filter(isRec) : []
}

function nameOf(plugin: Rec): string {
  return typeof plugin.name === 'string' ? plugin.name : ''
}

/**
 * Runs the project's own `vitest/node` `resolveConfig`, so every plugin's `config` and
 * `configResolved` hook runs, and reads `.test`, the JSX and define settings and the user's
 * plugins. A user plugin is one the same resolve with no config file doesn't have (Vite's own and
 * Vitest's are in both). Without Vite installed it returns `null` fields' worth of nothing: an
 * empty plugin list and one warning.
 * @public
 */
export async function loadViteBridge(options: ViteBridgeOptions): Promise<LoadedViteBridge> {
  const { root, configFile, mode } = options
  const empty = (warning: string): LoadedViteBridge => ({
    result: {
      test: {},
      jsx: null,
      defines: {},
      scriptDefines: {},
      resolveConditions: [],
      plugins: [],
      configHash: null,
      warnings: [warning],
    },
    plugins: [],
  })
  let resolveConfig: ResolveConfig
  try {
    resolveConfig = await importResolveConfig(root)
  } catch (cause) {
    const detail = cause instanceof Error ? ` (${cause.message})` : ''
    return empty(
      `the config has plugins, and Vite (through vitest/node) can't be loaded from "${root}"${detail}: the plugins are skipped`,
    )
  }
  const resolved = await resolveConfig({
    ...options.cliOptions,
    root,
    config: configFile,
    mode,
  })
  // Vite's and Vitest's own plugins are what a resolve with the same options and no config file
  // has: counted by name, so a user plugin that shares a built-in's name is still the user's.
  const baseline = new Map<string, number>()
  for (const plugin of pluginsOf(
    await resolveConfig({ ...options.cliOptions, root, config: false, mode }),
  )) {
    baseline.set(nameOf(plugin), (baseline.get(nameOf(plugin)) ?? 0) + 1)
  }
  const user = pluginsOf(resolved).filter((plugin) => {
    const left = baseline.get(nameOf(plugin)) ?? 0
    if (left === 0) return true
    baseline.set(nameOf(plugin), left - 1)
    return false
  })
  const resolve = isRec(resolved.resolve) ? resolved.resolve : {}
  let configHash: string | null = null
  if (configFile !== false) {
    try {
      configHash = createHash('sha256').update(readFileSync(configFile)).digest('hex')
    } catch {
      configHash = null
    }
  }
  return {
    result: {
      test: isRec(resolved.test) ? resolved.test : {},
      jsx: viteJsxSettings(resolved),
      defines: isRec(resolved.test) && isRec(resolved.test.defines) ? resolved.test.defines : {},
      scriptDefines: scriptDefinesOf(resolved.test),
      resolveConditions: Array.isArray(resolve.conditions)
        ? resolve.conditions.filter((entry): entry is string => typeof entry === 'string')
        : [],
      plugins: user.map((plugin) => ({
        name: nameOf(plugin),
        version: versionOf(root, nameOf(plugin)),
        codeHash: codeHashOf(plugin),
      })),
      configHash,
      warnings: [],
    },
    plugins: user,
  }
}
