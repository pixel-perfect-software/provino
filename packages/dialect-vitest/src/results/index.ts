// `@provino/dialect-vitest/results` (B25g, T11.16, D171): Vitest 5.0.5's machine-read results, built
// from the run's events in the coordinator. Loaded only when a run asks for them, never by a worker.
export {
  createVitestResults,
  type VitestJsonAssertionResult,
  type VitestJsonResults,
  type VitestJsonStatus,
  type VitestJsonTestResult,
  type VitestResults,
  type VitestResultsOptions,
  type VitestSnapshotSummary,
} from './json.ts'
