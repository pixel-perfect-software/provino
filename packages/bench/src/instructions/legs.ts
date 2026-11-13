// The legs of `provino-bench instructions`: what each one runs, which task's guard it is, and the
// rise in instruction counts it flags. Pure data; `workloads.ts` runs them.

/**
 * A leg's id.
 * @public
 */
export type LegId =
  | 'app-50'
  | 'mock-heavy-50'
  | 'isolate-heavy'
  | 'loader-e2e'
  | 'core'
  | 'transform'
  | 'hoist'
  | 'resolve'
  | 'warm'

/**
 * One guarded workload.
 * @public
 */
export interface Leg {
  readonly id: LegId
  /** The task whose guard this is. */
  readonly task: 'T12.13' | 'T2.12' | 'T5.14' | 'T3.12'
  /**
   * The rise over the baseline, in percent, at or above which the leg is flagged: T12.13's +1.5%
   * for the suites (and T2.12's loader leg, which runs on T12.13's job); T5.14's 20% budget; T3.12's
   * alert at +20%.
   */
  readonly thresholdPercent: number
  /** What one unit of `units` is, for the per-unit wall signal. */
  readonly unit: 'file' | 'test' | 'call' | 'request'
  /** What it runs, for the summary. */
  readonly what: string
}

/**
 * Every leg, in the order they run.
 * @public
 */
export const LEGS: readonly Leg[] = [
  {
    id: 'app-50',
    task: 'T12.13',
    thresholdPercent: 1.5,
    unit: 'file',
    what: 'app-50 (Jest tree) in one inline worker, Jest dialect, registry tier',
  },
  {
    id: 'mock-heavy-50',
    task: 'T12.13',
    thresholdPercent: 1.5,
    unit: 'file',
    what: 'mock-heavy-50 (Jest tree, hoisted jest.mock) in one inline worker',
  },
  {
    id: 'isolate-heavy',
    task: 'T12.13',
    thresholdPercent: 1.5,
    unit: 'file',
    what: 'isolate-heavy (a 2 MB module, re-evaluated per file) in one inline worker',
  },
  {
    id: 'loader-e2e',
    task: 'T2.12',
    thresholdPercent: 1.5,
    unit: 'file',
    what: "bench:loader e2e's Provino side: Spike A's 200 files through the loader, registry tier",
  },
  {
    id: 'core',
    task: 'T5.14',
    thresholdPercent: 20,
    unit: 'test',
    what: "bench:core's workload: 10,000 empty tests, 3 hooks each, locations off + ALS",
  },
  {
    id: 'transform',
    task: 'T3.12',
    thresholdPercent: 20,
    unit: 'file',
    what: 'the pipeline over the 120-file TS corpus, then the module-runner form, no cache',
  },
  {
    id: 'hoist',
    task: 'T3.12',
    thresholdPercent: 20,
    unit: 'call',
    what: "hoistMocks on bench:hoist's 15 KB mocked file, Jest policy",
  },
  {
    id: 'resolve',
    task: 'T3.12',
    thresholdPercent: 20,
    unit: 'request',
    what: 'every import of the TS corpus through one resolver, twice (the second pass warm)',
  },
  {
    id: 'warm',
    task: 'T3.12',
    thresholdPercent: 20,
    unit: 'file',
    what: 'the TS corpus read back from a filled transform cache by a new pipeline',
  },
]

/**
 * The leg with `id`, or `undefined`.
 * @public
 */
export function legOf(id: string): Leg | undefined {
  return LEGS.find((leg) => leg.id === id)
}
