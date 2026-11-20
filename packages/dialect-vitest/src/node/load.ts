// B25c, T11.15, open question 1 (a): import `vitest.config.*` or `vite.config.*` natively, through the
// config package's loader (Node's own TypeScript stripping, a fresh read per call). `vitest/config`
// is answered by the stand-in (`vitest-config-stand-in.ts`) through a resolve and load hook that
// lives only while an import runs, so the project's own Vitest and Vite are never loaded to read a
// config. A function export is called with Vite's `ConfigEnv`.

import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ConfigError, importConfigModule } from '@provino/config'
import type { ConfigSource } from '@provino/types'
import { transformSync } from 'oxc-transform'
import { VitestConfigError } from './errors.ts'
import { vitestConfigStandIn } from './vitest-config-stand-in.ts'

const STAND_IN_URL = 'provino-vitest-config:stand-in'
const STAND_IN_KEY = Symbol.for('provino.vitest.config-stand-in')

const STAND_IN_SOURCE = `const s = globalThis[Symbol.for('provino.vitest.config-stand-in')]
export const defineConfig = s.defineConfig
export const defineProject = s.defineProject
export const mergeConfig = s.mergeConfig
export const configDefaults = s.configDefaults
export const coverageConfigDefaults = s.coverageConfigDefaults
export const defaultExclude = s.defaultExclude
export const defaultInclude = s.defaultInclude
export default s
`

/** A declaration of `name` in the module, which a second one would clash with. */
function declares(text: string, name: string): boolean {
  return new RegExp(
    `(?:\\b(?:const|let|var|function|class)\\s+${name}\\b|\\bas\\s+${name}\\b|[{,]\\s*${name}\\s*[,}]\\s*=|\\bimport\\s+${name}\\b)`,
  ).test(text)
}

/**
 * Vite bundles a config and defines `__dirname` and `__filename` in it, whatever its module
 * format, so a config written for the bundler may use them in an ES module. Node doesn't, so an
 * ES module of the project (not under `node_modules`) that names one without declaring it gets
 * the two as constants of its own path.
 */
/** The project's own files: what Vite's bundler reads, and so what these hooks change. */
function isProjectFile(url: string): boolean {
  return url.startsWith('file:') && !url.includes('/node_modules/')
}

const TRANSFORMED = /\.[cm]?[jt]sx?$/

/** Whether stripped source is ES module source: a static import or export, or `import.meta`. */
function hasModuleSyntax(code: string): boolean {
  return /^\s*(?:import\b|export\b)|\bimport\.meta\b/m.test(code)
}

/** Whether a name is a plain identifier, so a JSON key can be a named export. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

function jsonModule(text: string): string {
  const value: unknown = JSON.parse(text)
  const names =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.keys(value).filter((key) => IDENTIFIER.test(key) && key !== 'default')
      : []
  const named = names.map((name) => `export const ${name} = __json[${JSON.stringify(name)}];`)
  return [`const __json = ${text};`, 'export default __json;', ...named].join('\n')
}

/**
 * Loads a project file the way Vite's bundler reads a config: JSON is a module, a `.js` or `.ts`
 * file is ES module source whatever its package says (unless it is CommonJS by its own syntax),
 * TypeScript is stripped and an import used only as a type goes with it (no run-time import of
 * `vite` for `import { UserConfig } from 'vite'`), and `__dirname` and `__filename` are
 * defined. Everything else, and anything under `node_modules`, loads as Node loads it.
 */
function bundled<T extends { format?: string | null | undefined; source?: unknown }>(
  url: string,
  context: { format?: string | null | undefined },
  next: (url: string, context: never) => T,
): T | { format: 'module'; source: string; shortCircuit: true } {
  if (!isProjectFile(url)) return next(url, context as never)
  const file = fileURLToPath(url.replace(/[?#].*$/, ''))
  if (file.endsWith('.json') && context.format === 'module') {
    return { format: 'module', source: jsonModule(readFileSync(file, 'utf8')), shortCircuit: true }
  }
  if (!TRANSFORMED.test(file) || file.endsWith('.d.ts')) {
    return withDirnames(url, next(url, context as never))
  }
  const source = readFileSync(file, 'utf8')
  const output = transformSync(file, source, { sourcemap: false })
  if (output.errors.length > 0) {
    throw new Error(`can't read ${file}: ${output.errors[0]?.message ?? 'syntax error'}`)
  }
  // A file that is CommonJS by its own syntax (or a .cts/.cjs) keeps Node's loader.
  if (!hasModuleSyntax(output.code) || /\.c[jt]s$/.test(file)) {
    return withDirnames(url, next(url, context as never))
  }
  return withDirnames(url, { format: 'module', source: output.code, shortCircuit: true } as never)
}

function withDirnames<T extends { format?: string | null | undefined; source?: unknown }>(
  url: string,
  result: T,
): T {
  if (!url.startsWith('file:') || url.includes('/node_modules/')) return result
  if (result.format !== 'module' && result.format !== 'module-typescript') return result
  if (result.source === undefined || result.source === null) return result
  const text = String(result.source)
  const wanted = ['__dirname', '__filename'].filter(
    (name) => new RegExp(`\\b${name}\\b`).test(text) && !declares(text, name),
  )
  if (wanted.length === 0) return result
  const file = fileURLToPath(url.replace(/[?#].*$/, ''))
  const lines = wanted.map(
    (name) => `const ${name} = ${JSON.stringify(name === '__dirname' ? dirname(file) : file)};`,
  )
  return { ...result, source: `${lines.join(' ')}\n${text}` }
}

const SUFFIXES: readonly string[] = [
  '.ts',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '/index.ts',
  '/index.mts',
  '/index.js',
  '/index.mjs',
]

/**
 * Vite's bundler finds `./utils` as `./utils.ts` or `./utils/index.ts`; Node's ES loader doesn't.
 * The file a relative import without an extension names, if there is one.
 */
function withoutExtension(specifier: string, parent: string | undefined): string | undefined {
  if (parent === undefined || !(specifier.startsWith('.') || specifier.startsWith('/')))
    return undefined
  const base = fileURLToPath(new URL(specifier, parent))
  for (const suffix of SUFFIXES) {
    const path = `${base}${suffix}`
    if (existsSync(path)) return pathToFileURL(path).href
  }
  return undefined
}

let active = 0
let deregister: (() => void) | undefined

/** Installs the hooks for the length of `work`; overlapping loads share one pair. */
async function withStandIn<T>(work: () => Promise<T>): Promise<T> {
  if (active === 0) {
    Reflect.set(globalThis, STAND_IN_KEY, vitestConfigStandIn)
    const handle = registerHooks({
      resolve(specifier, context, next) {
        if (specifier === 'vitest/config') return { url: STAND_IN_URL, shortCircuit: true }
        try {
          const resolved = next(specifier, context)
          // Vite's bundler reads a JSON import with no attribute; Node refuses it.
          if (
            isProjectFile(resolved.url) &&
            /\.json$/.test(resolved.url.replace(/[?#].*$/, '')) &&
            context.importAttributes?.type !== 'json'
          ) {
            return { ...resolved, format: 'module' }
          }
          return resolved
        } catch (error) {
          const found = withoutExtension(specifier, context.parentURL)
          if (found === undefined) throw error
          return next(found, context)
        }
      },
      load(url, context, next) {
        if (url === STAND_IN_URL) {
          return { format: 'module', source: STAND_IN_SOURCE, shortCircuit: true }
        }
        return bundled(url, context, next)
      },
    })
    deregister = () => handle.deregister()
  }
  active++
  try {
    return await work()
  } finally {
    active--
    if (active === 0) {
      deregister?.()
      deregister = undefined
      Reflect.deleteProperty(globalThis, STAND_IN_KEY)
    }
  }
}

/**
 * What a config file gave.
 * @public
 */
export interface VitestLoadedConfig {
  readonly path: string
  /** The Vite-shaped config: `test`, `resolve`, `define`, `plugins`, `root`, … */
  readonly config: Readonly<Record<string, unknown>>
  /** A non-empty `plugins` list: their `config` hooks can change `test`, so Phase 4's bridge reads it. */
  readonly needsVite: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a Vite `plugins` value holds a plugin (nested arrays, promises, falsy entries skipped). */
function hasPlugin(plugins: unknown): boolean {
  if (Array.isArray(plugins)) return plugins.some(hasPlugin)
  return Boolean(plugins)
}

/**
 * Imports the config at `source` and returns what it exports: the object, or what a (maybe async)
 * function export returns when called with `{ command: 'serve', mode }`.
 * @public
 */
export async function loadVitestConfig(
  source: ConfigSource,
  options: { readonly mode: string },
): Promise<VitestLoadedConfig> {
  let value: unknown
  try {
    value = await withStandIn(() => importConfigModule(source.path))
  } catch (cause) {
    const message =
      cause instanceof ConfigError ? cause.message : `can't load the config file "${source.path}"`
    throw new VitestConfigError('VITEST_CONFIG_LOAD_FAILED', message, { cause })
  }
  try {
    if (typeof value === 'function') {
      value = await value({
        command: 'serve',
        mode: options.mode,
        isSsrBuild: false,
        isPreview: false,
      })
    } else {
      value = await value
    }
  } catch (cause) {
    throw new VitestConfigError(
      'VITEST_CONFIG_LOAD_FAILED',
      `the config function in "${source.path}" threw`,
      { cause },
    )
  }
  if (!isRecord(value)) {
    throw new VitestConfigError(
      'VITEST_CONFIG_INVALID',
      `the config file "${source.path}" must export an object, or a function that returns one`,
    )
  }
  return { path: source.path, config: value, needsVite: hasPlugin(value.plugins) }
}
