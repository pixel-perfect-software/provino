// @provino/coverage/runtime: what runs in the worker. The collectors arrive with B23b's later
// phases.
export { CoverageError, type CoverageErrorCode } from '@provino/coverage'
export { createCoverageFilter } from '../filter.ts'
export type { InitialCoverage } from '../initial-coverage.ts'
export type { IstanbulInstrumenterOptions } from '../instrument.ts'
export { loadInstrumenter } from '../load-instrumenter.ts'
export {
  createMapInterner,
  type InternedCoverage,
  type IstanbulCounters,
  type MapInterner,
} from './intern.ts'
export { createIstanbulCollector, type IstanbulCollectorOptions } from './istanbul-collector.ts'
export { createV8Collector, type V8CollectorOptions } from './v8-collector.ts'
