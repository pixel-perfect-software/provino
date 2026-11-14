// What the coordinator does with a run's coverage once the tests are over: the merge, the remap and
// the reports and the thresholds. One module behind `loadCoverageReporting`, so a run without coverage loads none of
// the Istanbul libraries.
export { type CoverageAggregate, createCoverageAggregate, createCoverageMap } from './aggregate.ts'
export { type RemappedCoverage, remapCoverage } from './remap.ts'
export { type ReportStream, type WriteReportsOptions, writeCoverageReports } from './reports.ts'
export {
  type CheckThresholdsOptions,
  checkThresholds,
  type ThresholdPolicy,
} from './thresholds.ts'
export { coverageTotals } from './totals.ts'
