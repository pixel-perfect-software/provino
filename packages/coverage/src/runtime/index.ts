// @provino/coverage/runtime: what runs in the worker. The collectors arrive with B23b's later
// phases.
export { CoverageError, type CoverageErrorCode } from '@provino/coverage'
export { createCoverageFilter } from '../filter.ts'
export type { InitialCoverage } from '../initial-coverage.ts'
export type { IstanbulInstrumenterOptions } from '../instrument.ts'
export {
  createMapInterner,
  type InternedCoverage,
  type IstanbulCounters,
  type MapInterner,
} from './intern.ts'
export { createIstanbulCollector, type IstanbulCollectorOptions } from './istanbul-collector.ts'
export { createV8Collector, type V8CollectorOptions } from './v8-collector.ts'

/**
 * The Istanbul instrumenter and the initial-coverage reader, loaded on demand: they bring the
 * parser and the code writer, which a worker running V8 coverage (or none) never loads.
 * @public
 */
export async function loadInstrumenter(): Promise<{
  readonly istanbulInstrumenter: typeof import('../instrument.ts').istanbulInstrumenter
  readonly readInitialCoverage: typeof import('../initial-coverage.ts').readInitialCoverage
}> {
  const [{ istanbulInstrumenter }, { readInitialCoverage }] = await Promise.all([
    import('../instrument.ts'),
    import('../initial-coverage.ts'),
  ])
  return { istanbulInstrumenter, readInitialCoverage }
}
