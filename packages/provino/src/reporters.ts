// `provino/reporters`: the built-in reporters and what a custom one is written against. Not built
// yet: custom reporter modules named in a config (T11.9) and `blob` (T9.8).
export {
  AGENT_VARIABLES,
  agentReporter,
  createStyle,
  type DefaultReporterOptions,
  type DetectOptions,
  defaultReporter,
  defineReporter,
  detectOutput,
  dotReporter,
  type Environment,
  type GitHubActionsReporterOptions,
  githubActionsReporter,
  type JUnitReporterOptions,
  jsonReporter,
  junitReporter,
  type NormalizedJsonReporterOptions,
  normalizedJsonReporter,
  type OutputEnvironment,
  type OutputStream,
  type Style,
  type TextReporterOptions,
  type TextSink,
  verboseReporter,
} from '@provino/reporters'
export type { Reporter } from '@provino/types'
