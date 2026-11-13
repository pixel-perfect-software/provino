// `provino/config`: what a `provino.config.*` file and its tools type against. Not built yet:
// `defineConfig` and `defineProject` (T1.4's rest), which this entry will export beside the types.
export {
  ConfigError,
  type ConfigErrorCode,
  type ConfigIssue,
  formatConfigIssue,
} from '@provino/config'
export type {
  BaseConfig,
  ConfigEnv,
  DialectKeys,
  PluginKeys,
  ProjectConfig,
  ProvinoConfigInput,
  ReservedConfigKey,
} from '@provino/types'
