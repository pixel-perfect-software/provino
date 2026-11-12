// @provino/config: loads a config file and resolves a project from it (T1.4's first part, for
// B11). Not built yet: `defineConfig`, key-by-key validation of unknown keys, `projects`,
// `plugins`, `alsoServe`, and the Oxc fallback for a `.ts` file Node can't load (T1.4).
export { ConfigError, type ConfigErrorCode, type ConfigIssue, formatConfigIssue } from './errors.ts'
export { importConfigModule, loadConfigFile, loadProject } from './load.ts'
export {
  type ResolvedProject,
  type ResolveNeutralProjectOptions,
  type ResolveProjectOptions,
  resolveNeutralProject,
  resolveProject,
} from './resolve.ts'
export { pruneTransformCache, withTransformCache } from './transform-cache.ts'
