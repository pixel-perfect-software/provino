// A watch plugin as jest-watcher's `WatchPlugin` type has it (`types.ts`, `BaseWatchPlugin.ts`
// L17-L42), and jest-core `lib/watchPluginsHelpers.ts` L12-L56: which plugins own a key, and the
// usage rows in order.
import type { JestGlobalConfig } from '../types.ts'
import type { JestHookSubscriber } from './hooks.ts'
import type { JestWatchConfigUpdate } from './update-global-config.ts'

/**
 * A usage row: the key and what it does (`UsageData`).
 * @beta
 */
export interface JestUsageData {
  readonly key: string
  readonly prompt: string
}

/**
 * What a plugin's `run` gets to start a run with a new config (`UpdateConfigCallback`).
 * @beta
 */
export type JestUpdateConfigAndRun = (update?: JestWatchConfigUpdate) => void

/**
 * A watch plugin. `isInternal` sorts Jest's own before any other; `FailedTestsInteractive` is not
 * marked, so its row comes after the internal ones.
 * @beta
 */
export interface JestWatchPlugin {
  readonly isInternal?: true
  apply?(hooks: JestHookSubscriber): void
  getUsageInfo?(globalConfig: JestGlobalConfig): JestUsageData | null
  onKey?(key: string): void
  /** Resolves truthy when the driver should run again with the config as it is (Jest's `boolean`). */
  run?(globalConfig: JestGlobalConfig, updateConfigAndRun: JestUpdateConfigAndRun): Promise<unknown>
}

function usageOf(plugin: JestWatchPlugin, globalConfig: JestGlobalConfig): JestUsageData | null {
  return plugin.getUsageInfo?.(globalConfig) ?? null
}

/**
 * `filterInteractivePlugins` (L12-L29): the plugins with a usage row whose key no later plugin
 * takes.
 * @beta
 */
export function filterInteractivePlugins(
  plugins: readonly JestWatchPlugin[],
  globalConfig: JestGlobalConfig,
): JestWatchPlugin[] {
  const infos = plugins.map((plugin) => usageOf(plugin, globalConfig))
  return plugins.filter((_plugin, index) => {
    const info = infos[index]
    if (info === null || info === undefined) return false
    return !infos.slice(index + 1).some((later) => later !== null && later?.key === info.key)
  })
}

/**
 * `getSortedUsageRows` (L31-L56): internal plugins first in their own order, the others after them
 * by key.
 * @beta
 */
export function getSortedUsageRows(
  plugins: readonly JestWatchPlugin[],
  globalConfig: JestGlobalConfig,
): JestUsageData[] {
  return filterInteractivePlugins(plugins, globalConfig)
    .sort((a, b) => {
      if (a.isInternal && b.isInternal) return 0
      if (a.isInternal !== b.isInternal) return a.isInternal ? -1 : 1
      const infoA = usageOf(a, globalConfig)
      const infoB = usageOf(b, globalConfig)
      if (infoA !== null && infoB !== null) return infoA.key.localeCompare(infoB.key)
      return 0
    })
    .flatMap((plugin) => {
      const info = usageOf(plugin, globalConfig)
      return info === null ? [] : [info]
    })
}

/**
 * The key a plugin owns (`watch.ts` L525-L534).
 * @beta
 */
export function pluginKey(plugin: JestWatchPlugin, globalConfig: JestGlobalConfig): string | null {
  return usageOf(plugin, globalConfig)?.key ?? null
}
