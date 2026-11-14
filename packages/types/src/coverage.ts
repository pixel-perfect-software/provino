// Track 8 §Types → Coverage contract. The provider is loaded in both processes: the worker
// creates a collector, the coordinator merges and reports.
import type { JsonValue } from './clone-safe.ts'
import type { SerializedError } from './runtime/tree.ts'
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
 * One file's Istanbul coverage data, as `istanbul-lib-instrument` writes it and
 * `istanbul-lib-coverage`'s `FileCoverage` reads it: the maps of statements, functions and
 * branches, and the counters. `hash` and `_coverageSchema` are present on instrumented output.
 * @public
 */
export interface IstanbulFileCoverageData {
  readonly path: string
  readonly statementMap: Readonly<Record<string, IstanbulRange>>
  readonly fnMap: Readonly<
    Record<
      string,
      {
        readonly name: string
        readonly decl: IstanbulRange
        readonly loc: IstanbulRange
        readonly line?: number
      }
    >
  >
  readonly branchMap: Readonly<
    Record<
      string,
      {
        readonly loc?: IstanbulRange
        readonly type: string
        readonly locations: readonly IstanbulRange[]
        readonly line?: number
      }
    >
  >
  readonly s: Readonly<Record<string, number>>
  readonly f: Readonly<Record<string, number>>
  readonly b: Readonly<Record<string, readonly number[]>>
  readonly hash?: string
  readonly _coverageSchema?: string
  readonly inputSourceMap?: SourceMapV3
}

/**
 * A source range in Istanbul's coordinates: lines from 1, columns from 0.
 * @public
 */
export interface IstanbulRange {
  readonly start: { readonly line: number; readonly column: number | null }
  readonly end: { readonly line: number; readonly column: number | null }
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
      /**
       * The compiled modules the scripts are of, one per script URL a worker evaluated: what maps
       * V8's offsets back to a source. Absent from a blob that has none.
       */
      readonly modules?: readonly ExecutedModuleInfo[]
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
 * Instruments code for Istanbul coverage (a Track 3 transform hook). The pipeline calls it on a
 * file requested with `instrument: true`, after TypeScript is stripped (or the project's
 * transformer ran) and before the hoister: `code` is that output and `inputMap` the map the earlier
 * steps composed from it to the source (`null` when none changed positions). `map` leads the
 * returned code back to `code` (`null` when the code is unchanged); it does not include `inputMap`,
 * which the pipeline composes and the instrumenter embeds in the coverage data.
 * @public
 */
export interface CoverageInstrumenter {
  readonly name: string
  instrument(
    code: string,
    filename: string,
    inputMap: SourceMapV3 | null,
  ): {
    code: string
    map: SourceMapV3 | null
    /** The file's initial coverage (every counter zero), when the instrumenter has it. */
    coverage?: IstanbulFileCoverageData
  }
}

/**
 * What a worker needs to decide which files to instrument and count (sent in
 * `SerializedProjectConfig.coverage`). Globs are strings and matchers are built in the worker.
 * @public
 */
export interface SerializedCoverageConfig {
  readonly provider: 'v8' | 'istanbul'
  /**
   * Absolute: Jest's `globalRootDir`, the run's root. The include globs match against the path
   * relative to it, and V8 counts only files whose path begins with it.
   */
  readonly globalRoot: string
  /**
   * Absolute: this project's `rootDir`. Istanbul instruments no file outside it (Babel's `cwd`).
   * It differs from `globalRoot` when several projects run in one pool.
   */
  readonly projectRoot: string
  /**
   * Absolute: the root Istanbul instruments within, when it is not `projectRoot` (Babel's `cwd`
   * for a transform that instruments its own output: Jest's babel-jest passes the process's
   * working directory, so a file outside it is left uninstrumented although it is under the
   * project's root). Absent: `projectRoot`.
   */
  readonly instrumentRoot?: string
  /** The include globs (Jest's `collectCoverageFrom`); empty means every file the tests load. */
  readonly include: readonly string[]
  /** Whether the include globs match against the root-relative path. */
  readonly includeRoot: boolean
  /** Files that count even when a test-file or node_modules rule would skip them (`forceCoverageMatch`). */
  readonly force: readonly string[]
  /** The globs that make a file a test file (never counted), unless an ignore pattern below matches it. */
  readonly testFiles: readonly string[]
  /** Regular expression sources that make a file a test file (never counted), unless an ignore pattern matches it. */
  readonly testRegex: readonly string[]
  /** Regular expression sources of paths that are never test files, whatever the two above say. */
  readonly testIgnorePatterns: readonly string[]
  /** Regular expression sources of paths to leave out (`coveragePathIgnorePatterns`). */
  readonly excludePatterns: readonly string[]
  /** Absolute paths to leave out (the config, setup and transform files). */
  readonly excludePaths: readonly string[]
}

/**
 * A threshold group: `name` is `global`, a path or a glob, in the order the config gave it.
 * @public
 */
export interface CoverageThresholdGroup extends MetricThresholds {
  readonly name: string
}

/**
 * What the coordinator needs to merge, report and check a run's coverage.
 * @public
 */
export interface RunCoverageOptions {
  readonly provider: 'v8' | 'istanbul'
  /** Reporter names with their options, as Istanbul's reports take them. */
  readonly reporters: readonly (string | readonly [string, Readonly<Record<string, JsonValue>>])[]
  /** Absolute. */
  readonly directory: string
  /** Istanbul watermarks: `[low, high]` per metric. */
  readonly watermarks: { readonly [M in CoverageMetric]: readonly [number, number] }
  /** The thresholds, in config order (Jest's first match wins). */
  readonly thresholds: readonly CoverageThresholdGroup[]
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
  /**
   * The merged Istanbul data per file, by absolute path, moved back to the sources (what Jest's
   * `coverageMap` is made of).
   */
  readonly map: Readonly<Record<string, IstanbulFileCoverageData>>
  /**
   * The original text of each source in `map` that is not on disk at its path (a generated or
   * virtual file whose map carried `sourcesContent`), by absolute path: the reports read it before
   * the disk. Absent when every source is on disk.
   */
  readonly sources?: Readonly<Record<string, string>>
  /** The files no test loaded whose coverage could not be made, each with why. Absent when none. */
  readonly untestedFailures?: readonly {
    readonly path: string
    readonly error: SerializedError
  }[]
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
