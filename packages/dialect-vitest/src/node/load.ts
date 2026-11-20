// B25c, T11.15, open question 1 (a): import `vitest.config.*` or `vite.config.*` natively, through the
// config package's loader (Node's own TypeScript stripping, a fresh read per call). `vitest/config`
// is answered by the stand-in (`vitest-config-stand-in.ts`) through a resolve and load hook that
// lives only while an import runs, so the project's own Vitest and Vite are never loaded to read a
// config. A function export is called with Vite's `ConfigEnv`.

import { registerHooks } from 'node:module'
import { ConfigError, importConfigModule } from '@provino/config'
import type { ConfigSource } from '@provino/types'
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

let active = 0
let deregister: (() => void) | undefined

/** Installs the hooks for the length of `work`; overlapping loads share one pair. */
async function withStandIn<T>(work: () => Promise<T>): Promise<T> {
  if (active === 0) {
    Reflect.set(globalThis, STAND_IN_KEY, vitestConfigStandIn)
    const handle = registerHooks({
      resolve(specifier, context, next) {
        if (specifier === 'vitest/config') return { url: STAND_IN_URL, shortCircuit: true }
        return next(specifier, context)
      },
      load(url, context, next) {
        if (url === STAND_IN_URL) {
          return { format: 'module', source: STAND_IN_SOURCE, shortCircuit: true }
        }
        return next(url, context)
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
