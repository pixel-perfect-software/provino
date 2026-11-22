// `provino/config`: what a `provino.config.*` file and its tools type against.
export {
  ConfigError,
  type ConfigErrorCode,
  type ConfigIssue,
  defineConfig,
  formatConfigIssue,
} from '@provino/config'
export type {
  BaseConfig,
  ConfigEnv,
  DialectKeys,
  DialectRegistry,
  PluginKeys,
  PluginRegistry,
  ProjectConfig,
  ProvinoConfig,
  ProvinoConfigInput,
  ReservedConfigKey,
} from '@provino/types'
