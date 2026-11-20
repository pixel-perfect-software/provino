import type { ProvinoConfig } from '@provino/types'

/**
 * Types a `provino.config.*` file's default export and returns it unchanged: the config object,
 * or a (maybe async) function of the `ConfigEnv` that returns one. The argument keeps the type it
 * was written with, so a function's `env` is typed and a literal's keys are checked (an unknown
 * key is an error here, and `CONFIG_UNKNOWN_KEY` when the file loads without a type check).
 * @public
 */
export function defineConfig<const Config extends ProvinoConfig>(config: Config): Config {
  return config
}
