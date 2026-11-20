// @provino/transform/vite: the Vite plugin host (T3.9). Loaded only when a project has plugins.

export type { ViteHostErrorCode } from './errors.ts'
export { ViteHostError } from './errors.ts'
export type { FilterPattern, FilterValue, HookFilter } from './filter.ts'
export type {
  ViteHost,
  ViteHostOptions,
  VitePlugin,
  VitePluginContext,
  VitePluginHook,
  VitePluginIdentity,
  ViteResolvedId,
  ViteSource,
} from './host.ts'
export {
  classifyViteId,
  createViteHost,
  pluginCodeHash,
  UNSUPPORTED_PLUGIN_HOOKS,
  viteHostFingerprint,
} from './host.ts'
