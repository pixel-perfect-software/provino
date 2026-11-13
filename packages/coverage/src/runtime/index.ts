// @provino/coverage/runtime: what runs in the worker. The collectors arrive with B23b's later
// phases.
export { CoverageError, type CoverageErrorCode } from '@provino/coverage'
export { type InitialCoverage, readInitialCoverage } from '../initial-coverage.ts'
export { type IstanbulInstrumenterOptions, istanbulInstrumenter } from '../instrument.ts'
