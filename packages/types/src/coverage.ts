// Track 8 §Types → Coverage contract. The provider is loaded in both processes: the worker
// creates a collector, the coordinator merges and reports.
import type { SourceMapV3 } from './transform.ts'

/**
 * A coverage metric.
 * @public
 */
export type CoverageMetric = 'statements' | 'branches' | 'functions' | 'lines'

/**
 * Thresholds per metric: a positive number is a minimum percentage, a negative one a maximum
 * count of uncovered items.
 * @public
 */
export type MetricThresholds = { readonly [M in CoverageMetric]?: number }

/**
 * Coverage thresholds, globally and per glob group.
 * @public
 */
export interface CoverageThresholds extends MetricThresholds {
  readonly groups?: Readonly<Record<string, MetricThresholds & { readonly perFile?: boolean }>>
  readonly perFile?: boolean
  /** Raise thresholds that the run beats; a function picks the new value. */
  readonly autoUpdate?: boolean | ((next: number, previous: number) => number)
  /** Shorthand for 100 on every metric. */
  readonly '100'?: boolean
}

/**
 * Coverage config.
 * @public
 */
export interface CoverageOptions {
  readonly enabled?: boolean
  readonly provider?: 'v8' | 'istanbul'
  readonly include?: readonly string[]
  readonly exclude?: readonly string[]
  readonly includeUntested?: boolean
  readonly reporters?: readonly (string | readonly [string, Readonly<Record<string, unknown>>])[]
  readonly reportsDirectory?: string
  readonly thresholds?: CoverageThresholds
  /** v8: count calls, not just hits (costs memory). */
  readonly hitCounts?: boolean
  /** v8: take coverage after each file, tagged with its test file (affected tests). */
  readonly perTestFile?: boolean
  /** Reproduce Jest's v8-to-istanbul numbers. */
  readonly legacyV8?: boolean
  readonly ignoreClassMethods?: readonly string[]
}

/**
 * One script's V8 coverage, as `node:inspector`'s `Profiler.takePreciseCoverage` reports it.
 * @beta
 */
export interface V8ScriptCoverage {
  readonly scriptId: string
  readonly url: string
  readonly functions: readonly {
    readonly functionName: string
    readonly isBlockCoverage: boolean
    readonly ranges: readonly {
      readonly startOffset: number
      readonly endOffset: number
      readonly count: number
    }[]
  }[]
}

/**
 * Raw coverage from one worker (or one shard blob).
 * @public
 */
export type RawCoverage =
  | {
      readonly kind: 'v8'
      readonly workerId: number
      readonly testFile?: string
      readonly scripts: readonly V8ScriptCoverage[]
    }
  | {
      readonly kind: 'istanbul'
      readonly workerId: number
      readonly testFile?: string
      readonly data: Readonly<Record<string, unknown>>
    }

/**
 * One evaluated user module, reported by the loader in the same batch as the coverage take.
 * @public
 */
export interface ExecutedModuleInfo {
  /** Equal to V8's `ScriptCoverage.url` (the vm filename or `sourceURL`). */
  readonly url: string
  /** Characters prepended before the transformed code. */
  readonly wrapperLength: number
  /** The transform cache key of this exact variant (Track 3). */
  readonly transformKey: string
}

/**
 * Looks up transformed code by cache key in the coordinator (Track 3 provides it).
 * @public
 */
export interface TransformLookup {
  get(
    transformKey: string,
  ): Promise<{ code: string; map: SourceMapV3 | null; originalPath: string } | null>
  transformUntested(path: string): Promise<{ code: string; map: SourceMapV3 | null } | null>
}

/**
 * Collects coverage in a worker.
 * @public
 */
export interface CoverageCollector {
  start(): Promise<void>
  take(testFile?: string): Promise<RawCoverage>
  stop(): Promise<void>
}

/**
 * Instruments code for Istanbul coverage (a Track 3 transform hook).
 * @public
 */
export interface CoverageInstrumenter {
  readonly name: string
  instrument(
    code: string,
    filename: string,
    inputMap: SourceMapV3 | null,
  ): { code: string; map: SourceMapV3 | null }
}

/**
 * Totals for one metric.
 * @beta
 */
export interface CoverageTotals {
  readonly total: number
  readonly covered: number
  /** 0–100. */
  readonly pct: number
}

/**
 * A finished coverage run: totals per metric, and the thresholds it missed.
 * @beta
 */
export interface CoverageSummary {
  readonly totals: { readonly [M in CoverageMetric]: CoverageTotals }
  readonly thresholdFailures: readonly string[]
}

/**
 * A coverage provider (v8 or istanbul).
 * @public
 */
export interface CoverageProvider {
  readonly name: 'v8' | 'istanbul'
  /** Worker side. */
  createCollector(): CoverageCollector
  instrumenter?(): CoverageInstrumenter
  /** Coordinator side: raw coverage from workers or shard blobs. */
  add(raw: RawCoverage): void
  finish(lookup: TransformLookup): Promise<CoverageSummary>
}
