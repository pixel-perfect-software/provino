// B25c, T11.15, open question 1 (a): import `vitest.config.*` or `vite.config.*` natively, through the
// config package's loader (Node's own TypeScript stripping, a fresh read per call). `vitest/config`
// is answered by the stand-in (`vitest-config-stand-in.ts`) through a resolve and load hook that
// lives only while an import runs, so the project's own Vitest and Vite are never loaded to read a
// config. A function export is called with Vite's `ConfigEnv`.

import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ConfigError, importConfigModule } from '@provino/config'
import type { ConfigSource } from '@provino/types'
import { parseSync } from 'oxc-parser'
import type * as Oxc from 'oxc-transform'
import { VitestConfigError } from './errors.ts'
import { isRec } from './util.ts'
import { viteStandIn, vitestConfigStandIn } from './vitest-config-stand-in.ts'

const STAND_IN_URL = 'provino-vitest-config:stand-in'
const VITE_STAND_IN_URL = 'provino-vitest-config:vite'
const STAND_IN_KEY = 'provino.vitest.config-stand-in'
const VITE_STAND_IN_KEY = 'provino.vitest.vite-stand-in'

/** The module a stand-in is served as: each member is a named export, the whole an `export default`. */
function standInSource(key: string, members: object): string {
  return [
    `const s = globalThis[Symbol.for(${JSON.stringify(key)})]`,
    ...Object.keys(members).map((name) => `export const ${name} = s.${name}`),
    'export default s',
    '',
  ].join('\n')
}

/** The project's own files: what Vite's bundler reads, and so what these hooks change. */
function isProjectFile(url: string): boolean {
  return url.startsWith('file:') && !url.includes('/node_modules/')
}

const TRANSFORMED = /\.[cm]?[jt]sx?$/

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

type ParsedModule = ReturnType<typeof parseSync>['module']

/**
 * Whether the file imports from `vite` only what the stand-in serves (`defineConfig`,
 * `mergeConfig`, `loadEnv`; a type import costs nothing), so reading it needs no real Vite.
 * An `export … from 'vite'`, a dynamic import or any other name keeps the real one.
 */
function importsOnlyServedFromVite(module: ParsedModule): boolean {
  if (module.dynamicImports.length > 0) return false
  const exported = module.staticExports.some((entry) =>
    entry.entries.some((item) => item.moduleRequest?.value === 'vite'),
  )
  if (exported) return false
  const served = new Set(Object.keys(viteStandIn))
  let imported = false
  for (const statement of module.staticImports) {
    if (statement.moduleRequest.value !== 'vite') continue
    imported = true
    for (const entry of statement.entries) {
      if (entry.isType) continue
      if (entry.importName.kind !== 'Name' || !served.has(entry.importName.name ?? '')) return false
    }
  }
  return imported
}

/** Parents (file URLs) whose `vite` import the stand-in answers; empty when no load is running. */
const standInParents = new Set<string>()

type OxcTransform = typeof Oxc

let oxcTransform: OxcTransform | undefined

/** Oxc's transform, loaded the first time a config needs it (a TypeScript one, or a `__dirname`). */
function transformer(): OxcTransform {
  oxcTransform ??= createRequire(import.meta.url)('oxc-transform') as OxcTransform
  return oxcTransform
}

/**
 * Loads a project file the way Vite's bundler reads a config: JSON is a module, a `.js` or `.ts`
 * file is ES module source whatever its package says (unless it is CommonJS by its own syntax),
 * TypeScript is stripped and an import used only as a type goes with it (no run-time import of
 * `vite` for `import { UserConfig } from 'vite'`), and `__dirname` and `__filename` are
 * defined where nothing declares them (the transform's own scope-aware define). Everything else,
 * and anything under `node_modules`, loads as Node loads it.
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
  if (!TRANSFORMED.test(file) || file.endsWith('.d.ts')) return next(url, context as never)
  const source = readFileSync(file, 'utf8')
  // The parse decides: a file the parser rejects is left to Node, which words the error.
  const parsed = parseSync(file, source)
  if (parsed.errors.length > 0) return next(url, context as never)
  // A file that is CommonJS by its own syntax (or a .cts/.cjs) keeps Node's loader.
  if (!parsed.module.hasModuleSyntax || /\.c[jt]s$/.test(file)) return next(url, context as never)
  if (importsOnlyServedFromVite(parsed.module)) standInParents.add(url)
  const typed = /\.[cm]?ts$|\.[jt]sx$/.test(file)
  const dirnames = /\b__(?:dirname|filename)\b/.test(source)
  // ES module source in a .js file needs no change but its format, whatever its package says.
  if (!typed && !dirnames) return { format: 'module', source, shortCircuit: true }
  const output = transformer().transformSync(file, source, {
    sourcemap: false,
    ...(dirnames
      ? { define: { __dirname: JSON.stringify(dirname(file)), __filename: JSON.stringify(file) } }
      : {}),
  })
  if (output.errors.length > 0) return next(url, context as never)
  return { format: 'module', source: output.code, shortCircuit: true }
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
    Reflect.set(globalThis, Symbol.for(STAND_IN_KEY), vitestConfigStandIn)
    Reflect.set(globalThis, Symbol.for(VITE_STAND_IN_KEY), viteStandIn)
    const handle = registerHooks({
      resolve(specifier, context, next) {
        if (specifier === 'vitest/config') return { url: STAND_IN_URL, shortCircuit: true }
        if (
          specifier === 'vite' &&
          context.parentURL !== undefined &&
          standInParents.has(context.parentURL)
        ) {
          return { url: VITE_STAND_IN_URL, shortCircuit: true }
        }
        try {
          const resolved = next(specifier, context)
          // Vite's bundler reads a JSON import with no attribute; Node refuses it.
          if (
            isProjectFile(resolved.url) &&
            /\.json$/.test(resolved.url.replace(/[?#].*$/, '')) &&
            context.importAttributes?.type !== 'json' &&
            !context.conditions.includes('require')
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
          return {
            format: 'module',
            source: standInSource(STAND_IN_KEY, vitestConfigStandIn),
            shortCircuit: true,
          }
        }
        if (url === VITE_STAND_IN_URL) {
          return {
            format: 'module',
            source: standInSource(VITE_STAND_IN_KEY, viteStandIn),
            shortCircuit: true,
          }
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
      Reflect.deleteProperty(globalThis, Symbol.for(STAND_IN_KEY))
      Reflect.deleteProperty(globalThis, Symbol.for(VITE_STAND_IN_KEY))
      standInParents.clear()
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

/** Whether a Vite `plugins` value holds a plugin (nested arrays, promises, falsy entries skipped). */
export function hasPlugin(plugins: unknown): boolean {
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
  // The config function runs inside the hooks too: its own imports go through them.
  const stage: { phase: 'import' | 'function' } = { phase: 'import' }
  let value: unknown
  try {
    value = await withStandIn(async () => {
      const exported = await importConfigModule(source.path)
      stage.phase = 'function'
      if (typeof exported !== 'function') return exported
      return exported({
        command: 'serve',
        mode: options.mode,
        isSsrBuild: false,
        isPreview: false,
      })
    })
  } catch (cause) {
    if (stage.phase === 'function') {
      throw new VitestConfigError(
        'VITEST_CONFIG_LOAD_FAILED',
        `the config function in "${source.path}" threw`,
        { cause },
      )
    }
    const message =
      cause instanceof ConfigError ? cause.message : `can't load the config file "${source.path}"`
    throw new VitestConfigError('VITEST_CONFIG_LOAD_FAILED', message, { cause })
  }
  if (!isRec(value)) {
    throw new VitestConfigError(
      'VITEST_CONFIG_INVALID',
      `the config file "${source.path}" must export an object, or a function that returns one`,
    )
  }
  return { path: source.path, config: value, needsVite: hasPlugin(value.plugins) }
}
