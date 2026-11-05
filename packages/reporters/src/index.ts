// @provino/reporters: the reporter bus, and the built-in reporters `default` and
// `normalized-json` (U4). Not built yet: the other built-in reporters, custom reporter modules,
// the TTY live view, console output in `default`, and goldens (T9.7), plus the normalized run's
// console, trace and snapshot state (T12.16).
export { createReporterBus, type ReporterBusHandle } from './bus.ts'
export { type DefaultReporterOptions, defaultReporter } from './default/reporter.ts'
export { defineReporter } from './define.ts'
export {
  type NormalizedJsonReporterOptions,
  normalizedJsonReporter,
} from './normalized-json/reporter.ts'
export type { TextSink } from './sink.ts'
