// @provino/config: loads a config file and resolves its project or projects (T1.4, B27d). Not
// built yet: `plugins`, `alsoServe`, and the Oxc fallback for a `.ts` file Node can't load (T1.4).

export { hasProvinoTag } from '@provino/transform'
export { type ResolvedCoverage, withCoverage } from './coverage.ts'
export { defineConfig } from './define.ts'
export {
  findConfigInDirectory,
  findConfigUpward,
  PROVINO_CONFIG_EXTENSIONS,
} from './discover.ts'
export { ConfigError, type ConfigErrorCode, type ConfigIssue, formatConfigIssue } from './errors.ts'
export { importConfigModule, interopDefault, loadConfigFile, loadProject } from './load.ts'
export {
  loadProjects,
  type ResolvedConfig,
  type ResolveProjectsOptions,
  resolveProjects,
} from './projects.ts'
export {
  type ResolvedGlobalSetup,
  type ResolvedProject,
  type ResolveNeutralProjectOptions,
  type ResolveProjectOptions,
  resolveNeutralProject,
  resolveProject,
  type UnseededProjectConfig,
} from './resolve.ts'
export { pruneTransformCache, withTransformCache } from './transform-cache.ts'
