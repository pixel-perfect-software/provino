// Third-party watch plugins as jest-core `watch.ts` (Jest 30.5.2) hosts them: `watchPlugins`
// loaded and constructed with `{ config, stdin, stdout }` (L199-L210, with the failure text of
// L210-L220), `checkForConflicts` and its two texts (L474-L515), `getPluginIdentifier` and
// `getPluginKey` (L517-L534). A plugin is user code that runs in the coordinator, beside the
// driver; nothing of it crosses to a worker.
import { relative, sep } from 'node:path'
import type { TextStyle } from '@provino/types'
import { requireOrImportModule } from '../load.ts'
import type { JestGlobalConfig } from '../types.ts'
import type { JestWatchOutput } from './context.ts'
import type { JestHookSubscriber } from './hooks.ts'
import {
  type JestUpdateConfigAndRun,
  type JestUsageData,
  type JestWatchPlugin,
  namedJestWatchPlugin,
  nameJestWatchPlugin,
} from './plugin.ts'
import type { JestWatchStdin } from './quit.ts'

/**
 * Why watch mode could not start with its plugins.
 *
 * - `JEST_WATCH_PLUGIN_LOAD`: a plugin's module failed to load, or its class to construct.
 * - `JEST_WATCH_PLUGIN_CONFLICT`: a plugin took a key Jest reserves, or one another plugin took.
 * - `JEST_WATCH_PLUGIN_HOOK`: a plugin's `onFileChange` listener threw (Jest's call is synchronous,
 *   so the throw ends the session: jest-cli prints its stack in red, exit 1).
 * @beta
 */
export type JestWatchPluginErrorCode =
  | 'JEST_WATCH_PLUGIN_LOAD'
  | 'JEST_WATCH_PLUGIN_CONFLICT'
  | 'JEST_WATCH_PLUGIN_HOOK'

/**
 * A watch plugin that could not be loaded or that conflicts. `message` is what jest-cli prints
 * for it (`run.ts` L30-L38: the error's `stack` in red, or the error itself where it has none),
 * and Jest exits 1.
 * @beta
 */
export class JestWatchPluginError extends Error {
  override readonly name = 'JestWatchPluginError'
  readonly code: JestWatchPluginErrorCode

  constructor(code: JestWatchPluginErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
  }
}

/**
 * What a key is reserved for (`ReservedInfo`): `forbiddenOverwriteMessage` set, no plugin may take
 * the key; unset, the first plugin to claim it replaces Jest's own.
 * @beta
 */
export interface JestReservedKey {
  readonly key?: string
  readonly forbiddenOverwriteMessage?: string
}

interface ReservedInfo {
  readonly forbiddenOverwriteMessage?: string | undefined
  readonly overwritable: boolean
  readonly plugin: JestWatchPlugin
}

/**
 * The keys taken so far (`WatchPluginKeysMap`).
 * @beta
 */
export type JestWatchPluginKeys = Map<string, ReservedInfo>

/**
 * `getPluginIdentifier` (L517-L523): the plugin class's `displayName`, else its `name`.
 * @beta
 */
export function getJestPluginIdentifier(plugin: JestWatchPlugin): string {
  return namedJestWatchPlugin(plugin) ?? classNameOf(plugin)
}

function classNameOf(value: object): string {
  const pluginClass: unknown = Reflect.get(value, 'constructor')
  if (typeof pluginClass !== 'function') return ''
  const displayName: unknown = Reflect.get(pluginClass, 'displayName')
  return (typeof displayName === 'string' && displayName) || pluginClass.name
}

/**
 * `getPluginKey` (L525-L534): the key of the plugin's usage row for this config, or `null`.
 * @beta
 */
export function getJestPluginKey(
  plugin: JestWatchPlugin,
  globalConfig: JestGlobalConfig,
): string | null {
  if (typeof plugin.getUsageInfo === 'function') {
    return (plugin.getUsageInfo(globalConfig) ?? { key: null }).key
  }
  return null
}

/**
 * The keys Jest's own plugins hold before any third-party one loads (L169-L188): a reserved key
 * from `reserved`, else the plugin's current key; a plugin with neither holds none.
 * @beta
 */
export function jestWatchPluginKeys(
  plugins: readonly JestWatchPlugin[],
  reserved: ReadonlyMap<JestWatchPlugin, JestReservedKey>,
  globalConfig: JestGlobalConfig,
): JestWatchPluginKeys {
  const keys: JestWatchPluginKeys = new Map()
  for (const plugin of plugins) {
    const info = reserved.get(plugin) ?? {}
    const key = info.key || getJestPluginKey(plugin, globalConfig)
    if (!key) continue
    keys.set(key, {
      forbiddenOverwriteMessage: info.forbiddenOverwriteMessage,
      overwritable: info.forbiddenOverwriteMessage == null,
      plugin,
    })
  }
  return keys
}

/**
 * `checkForConflicts` (L474-L515): a plugin with a key takes it when no one holds it or Jest's own
 * plugin may give it up; otherwise Jest's `ValidationError`, as jest-validate words it
 * (`utils.ts` L29-L41: `<name>:\n\n<message>\n`, red, the name bold).
 * @beta
 */
export function checkJestWatchPluginConflicts(
  keys: JestWatchPluginKeys,
  plugin: JestWatchPlugin,
  globalConfig: JestGlobalConfig,
  style: TextStyle,
): void {
  const key = getJestPluginKey(plugin, globalConfig)
  if (!key) return
  const conflictor = keys.get(key)
  if (!conflictor || conflictor.overwritable) {
    keys.set(key, { overwritable: false, plugin })
    return
  }
  const strong = (text: string): string => style.bold(style.red(text))
  let error: string
  if (conflictor.forbiddenOverwriteMessage) {
    error = [
      `Watch plugin ${strong(getJestPluginIdentifier(plugin))} attempted to register key ${strong(`<${key}>`)},`,
      `  that is reserved internally for ${strong(conflictor.forbiddenOverwriteMessage)}.`,
      '  Please change the configuration key for this plugin.',
    ].join('\n')
  } else {
    const plugins = [conflictor.plugin, plugin]
      .map((each) => strong(getJestPluginIdentifier(each)))
      .join(' and ')
    error = [
      `Watch plugins ${plugins} both attempted to register key ${strong(`<${key}>`)}.`,
      '  Please change the key configuration for one of the conflicting plugins to avoid overlap.',
    ].join('\n')
  }
  throw new JestWatchPluginError(
    'JEST_WATCH_PLUGIN_CONFLICT',
    style.red(`${style.bold('Watch plugin configuration error')}:\n\n${error}\n`),
  )
}

/**
 * What a third-party plugin is built with and how a failure is worded.
 * @beta
 */
export interface JestWatchPluginLoadOptions {
  readonly stdin: JestWatchStdin
  /** Jest's `outputStream`. */
  readonly stdout: JestWatchOutput
  readonly style: TextStyle
  /** What the plugin's path is printed relative to (`process.cwd()`). */
  readonly cwd: string
  /** `formatExecError(error, contexts[0].config, { noStackTrace: false })`. */
  readonly formatError: (error: unknown) => string
}

type PluginClass = new (options: {
  readonly config: unknown
  readonly stdin: unknown
  readonly stdout: unknown
}) => unknown

function isClass(value: unknown): value is PluginClass {
  return typeof value === 'function'
}

/** The plugin's own methods, called on it, so a class's `this` is its instance. */
function asWatchPlugin(instance: unknown): JestWatchPlugin {
  if (typeof instance !== 'object' || instance === null) return {}
  const method = (name: string): ((...args: unknown[]) => unknown) | undefined => {
    const value: unknown = Reflect.get(instance, name)
    return typeof value === 'function'
      ? (...args: unknown[]) => Reflect.apply(value, instance, args)
      : undefined
  }
  const apply = method('apply')
  const getUsageInfo = method('getUsageInfo')
  const onKey = method('onKey')
  const run = method('run')
  const plugin: JestWatchPlugin = {
    ...(Reflect.get(instance, 'isInternal') === true ? { isInternal: true } : {}),
    ...(apply === undefined
      ? {}
      : {
          apply: (hooks: JestHookSubscriber) => {
            apply(hooks)
          },
        }),
    ...(getUsageInfo === undefined
      ? {}
      : { getUsageInfo: (config: JestGlobalConfig) => usageOf(getUsageInfo(config)) }),
    ...(onKey === undefined
      ? {}
      : {
          onKey: (key: string) => {
            onKey(key)
          },
        }),
    ...(run === undefined
      ? {}
      : {
          run: (config: JestGlobalConfig, update: JestUpdateConfigAndRun) =>
            Promise.resolve(run(config, update)),
        }),
  }
  return nameJestWatchPlugin(classNameOf(instance), plugin)
}

/** What `getPluginKey` reads (`(info || {key: null}).key`): a row with a key, as the plugin gave it. */
function hasKey(value: object): value is JestUsageData {
  return Reflect.get(value, 'key') != null
}

/**
 * A usage row as Jest reads one: `key` and `prompt` exactly as the plugin returned them. A row with
 * a nullish `key` has no key, so no usage row and no conflict.
 */
function usageOf(value: unknown): JestUsageData | null {
  if (typeof value !== 'object' || value === null) return null
  return hasKey(value) ? value : null
}

/**
 * Loads one entry of `watchPlugins` (L199-L220): the module (jest-util's `requireOrImportModule`),
 * its default export constructed with `{ config, stdin, stdout }`. Any failure is Jest's
 * `Failed to initialize watch plugin` text.
 * @beta
 */
export async function loadJestWatchPlugin(
  entry: { readonly path: string; readonly config: unknown },
  options: JestWatchPluginLoadOptions,
): Promise<JestWatchPlugin> {
  try {
    const ThirdPartyPlugin = await requireOrImportModule(entry.path)
    if (!isClass(ThirdPartyPlugin)) throw new TypeError('ThirdPartyPlugin is not a constructor')
    return asWatchPlugin(
      new ThirdPartyPlugin({ config: entry.config, stdin: options.stdin, stdout: options.stdout }),
    )
  } catch (error) {
    const shown = relative(options.cwd, entry.path).split(sep).join('/')
    // The error has no stack (`delete errorWithContext.stack`), so jest-cli prints `String(error)`.
    throw new JestWatchPluginError(
      'JEST_WATCH_PLUGIN_LOAD',
      options.style.red(
        `Error: Failed to initialize watch plugin "${options.style.bold(shown)}":\n\n${options.formatError(error)}`,
      ),
      { cause: error },
    )
  }
}
