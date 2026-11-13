// @provino/reporters: the reporter bus and the built-in reporters: `default`, `verbose`, `dot`,
// `agent` (text), `json` (the `NormalizedRun`, also `normalized-json`), `junit` and
// `github-actions` (T9.7), with the detection they follow (a terminal, CI, an agent, colour).
// Not built yet: custom reporter modules (T11.9), `blob` (T9.8) and the console's origin line.
export { agentReporter } from './agent/reporter.ts'
export { createReporterBus, type ReporterBusHandle } from './bus.ts'
export { type DefaultReporterOptions, defaultReporter } from './default/reporter.ts'
export { defineReporter } from './define.ts'
export { dotReporter } from './dot/reporter.ts'
export {
  AGENT_VARIABLES,
  type DetectOptions,
  detectOutput,
  type Environment,
  type OutputEnvironment,
  type OutputStream,
} from './environment.ts'
export {
  type GitHubActionsReporterOptions,
  githubActionsReporter,
} from './github-actions/reporter.ts'
export { type JUnitReporterOptions, junitReporter } from './junit/reporter.ts'
export {
  jsonReporter,
  type NormalizedJsonReporterOptions,
  normalizedJsonReporter,
} from './normalized-json/reporter.ts'
export type { TextSink } from './sink.ts'
export { createStyle, type Style } from './style.ts'
export type { TextReporterOptions } from './text/reporter.ts'
export { verboseReporter } from './verbose/reporter.ts'
