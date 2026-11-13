// `provino/environment`: the test environments Provino ships, and what a custom one is written
// against. `happy-dom` joins in T8.
import type { DefineEnvironment } from '@provino/types'

export {
  JsdomEnvironmentError,
  type JsdomEnvironmentErrorCode,
  type JsdomEnvironmentOptions,
  jsdomEnvironment,
} from '@provino/env-jsdom'
export {
  NodeEnvironmentError,
  type NodeEnvironmentErrorCode,
  nodeEnvironment,
} from '@provino/env-node'
export type {
  Environment,
  EnvironmentInstance,
  EnvironmentOptionsMap,
  EnvironmentRealm,
  EnvironmentScope,
  EnvironmentSetupContext,
  EnvironmentTeardownReport,
  Pragmas,
} from '@provino/types'

/**
 * Declares a test environment. It returns the environment as it was given, and keeps its literal
 * `name` in the type, so a config can name it.
 * @public
 */
export const defineEnvironment: DefineEnvironment = (environment) => environment
