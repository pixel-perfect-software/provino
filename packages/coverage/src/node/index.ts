// @provino/coverage/node: what runs in the coordinator. The entry itself stays light (a run without
// coverage imports it for the store's types and the filter); the merge, the remap and the reports
// load through `loadCoverageReporting`, and the instrumenter through `loadInstrumenter`. The
// thresholds sit in that module too.
export { CoverageError, type CoverageErrorCode } from '@provino/coverage'
export { createCoverageFilter } from '../filter.ts'
export { loadInstrumenter } from '../load-instrumenter.ts'
export { expandIstanbulData, type KnownMaps } from './expand.ts'
export type {
  CoverageAggregate,
  RemappedCoverage,
  ReportStream,
  WriteReportsOptions,
} from './reporting.ts'

/**
 * The merge, the remap, the totals and the reports, loaded on demand: they bring the Istanbul
 * report libraries, which a run without coverage never loads.
 * @public
 */
export function loadCoverageReporting(): Promise<typeof import('./reporting.ts')> {
  return import('./reporting.ts')
}
