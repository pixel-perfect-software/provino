// Track 3 §Types → shared records, the pipeline's interface, and the Jest transformer types
// (structurally identical to `@jest/transform` 30). `@provino/transform` (B05) implements
// `Pipeline` and owns its options (`PipelineOptions`, `CacheOptions`, `ImportRewrite`). Track
// 2's `TransformedModule` is folded into `TransformRecord` (its one extra field is
// `hasTopLevelAwait`).
import type { HoistPolicy } from './hoist.ts'

/**
 * A standard v3 source map. Shared by transforms (Track 3), the loader (Track 2) and coverage
 * (Track 8).
 * @public
 */
export interface SourceMapV3 {
  readonly version: 3
  readonly file?: string | null
  readonly sourceRoot?: string
  readonly sources: readonly (string | null)[]
  readonly sourcesContent?: readonly (string | null)[]
  readonly names: readonly string[]
  readonly mappings: string
  readonly ignoreList?: readonly number[]
}

/**
 * One import in a source file. Offsets are in the original source.
 * @public
 */
export interface ImportRecord {
  readonly specifier: string
  readonly kind: 'static' | 'dynamic' | 'require' | 'reexport'
  /** `'*'` for a namespace use or one whose names are unknown. */
  readonly names: readonly string[] | '*'
  readonly start: number
  readonly end: number
}

/**
 * A hoisted mock call with a literal specifier (Track 4 registers it before the file runs).
 * @public
 */
export interface StaticMockCall {
  /** `mock`, `unmock`, `deepUnmock`, `enableAutomock`, … */
  readonly method: string
  readonly specifier: string
  readonly hasFactory: boolean
  readonly automock: boolean
  readonly factoryLoadsOriginal: boolean
  readonly loc: { readonly line: number; readonly column: number }
}

/**
 * Why a transform failed or warned.
 * @public
 */
export type TransformErrorCode =
  | 'PARSE_ERROR'
  /** A hoisted factory references a binding it may not (Jest). */
  | 'HOIST_FACTORY_OUT_OF_SCOPE'
  /** A hoisted call outside the top level (Vitest). */
  | 'HOIST_NOT_TOP_LEVEL'
  /** A hoisted call inside another hoisted call. */
  | 'HOIST_NESTED'
  /** An export of a hoisted call's result. */
  | 'HOIST_EXPORTED'
  /** `jest.mock(x, notAFunction)`. */
  | 'HOIST_FACTORY_NOT_FUNCTION'
  /** E.g. TC39 decorators with no lowering transformer. */
  | 'UNSUPPORTED_SYNTAX'
  /** A hosted Jest transformer or Vite plugin threw. */
  | 'TRANSFORMER_FAILED'
  /** A tsconfig `extends` entry can't be found. The rest of the config still applies, as in tsc. */
  | 'TSCONFIG_EXTENDS_NOT_FOUND'

/**
 * A problem found while transforming.
 * @public
 */
export interface TransformDiagnostic {
  readonly severity: 'error' | 'warning'
  readonly code: TransformErrorCode
  readonly message: string
  readonly loc?: { readonly line: number; readonly column: number }
  readonly codeFrame?: string
}

/**
 * One text edit of the module-runner step: `[start, end)` of the record's `code` becomes `text`
 * (an insertion when `start` equals `end`).
 * @beta
 */
export interface RunnerEdit {
  readonly start: number
  readonly end: number
  readonly text: string
}

/**
 * The record's `code` in module-runner form (imports as `__vite_ssr_import__` calls, exports as
 * getters), made by the pipeline when it is asked to and kept in the transform cache, so a warm run
 * skips the step. The loader evaluates it in place of running the step itself.
 * @beta
 */
export interface RunnerForm {
  readonly code: string
  /** Static import specifiers, in source order, each once. */
  readonly deps: readonly string[]
  readonly dynamicDeps: readonly string[]
  /** The edits that made `code` from the record's `code`: the source map is built from them on demand. */
  readonly edits: readonly RunnerEdit[]
}

/**
 * What a transform produces. The loader evaluates `code`; mocks, the dependency graph and
 * coverage read the rest.
 * @public
 */
export interface TransformRecord {
  readonly code: string
  /** `null` when no step moved code (strip-only, or untouched JS). */
  readonly map: SourceMapV3 | null
  readonly format: 'esm' | 'cjs' | 'unknown'
  readonly imports: readonly ImportRecord[]
  /** Hoisted mock calls with literal specifiers, in source order. */
  readonly staticMocks: readonly StaticMockCall[]
  /**
   * Whether the module's own source uses top-level await (sync `require` of it must throw). The
   * hoister's rewritten imports don't count: they are `lateDeps` (D38).
   */
  readonly hasTopLevelAwait: boolean
  /**
   * The specifiers of the static imports the hoister rewrote to `await __provino_import__(…)`, in
   * source order (D38). The loader never links them early, so mocks register first; it loads each
   * one when its call runs, synchronously when the module is, through the mock decision.
   */
  readonly lateDeps: readonly string[]
  readonly diagnostics: readonly TransformDiagnostic[]
  readonly cacheKey: string
  readonly fromCache: boolean
  /**
   * `code` in module-runner form, for an ES module, when the pipeline was created with
   * `runnerForm: true`. Absent otherwise (and for a module the step fails on).
   */
  readonly runner?: RunnerForm | undefined
}

/**
 * One file to transform.
 * @public
 */
export interface TransformRequest {
  /** Absolute. */
  readonly filename: string
  readonly source: string
  readonly role: 'test' | 'setup' | 'source' | 'dependency'
  readonly consumer: 'import' | 'require'
  /** Add coverage instrumentation (Track 8). */
  readonly instrument: boolean
}

/**
 * What the loader needs from the transform pipeline. Sync, because the native engine's load hook
 * can't await.
 * @public
 */
export interface ModuleTransformer {
  transform(request: TransformRequest): TransformRecord
}

/**
 * The transform pipeline (`createPipeline` in `@provino/transform`).
 * @public
 */
export interface Pipeline extends ModuleTransformer {
  /** For `processAsync` Jest transformers and async Vite hooks. */
  transformAsync(request: TransformRequest): Promise<TransformRecord>
  /** A stable hash of everything except file content; watch mode invalidates on it. */
  readonly fingerprint: string
}

/**
 * The signature of `defineHoistPolicy`: it keeps the literal call and value names, so a typo in a
 * dialect's policy is a compile error.
 * @public
 */
export type DefineHoistPolicy = <const Calls extends string, const Values extends string = never>(
  policy: HoistPolicy<Calls, Values>,
) => HoistPolicy<Calls, Values>

/**
 * The part of Jest's `Config.ProjectConfig` Provino reads (Track 8 lists what real environments
 * read). The compat host builds a full Jest config; this type stays structural so
 * `@provino/types` needs no Jest package.
 * @public
 */
export interface JestProjectConfigLike {
  readonly id: string
  readonly rootDir: string
  readonly testEnvironmentOptions: Readonly<Record<string, unknown>>
  readonly globals: Readonly<Record<string, unknown>>
  readonly fakeTimers: object
  readonly setupFiles: readonly string[]
  readonly injectGlobals: boolean
}

/**
 * A Jest source map: `version` is a number, not the literal 3 (Jest's `FixedRawSourceMap`).
 * @public
 */
export interface JestRawSourceMap extends Omit<SourceMapV3, 'version'> {
  readonly version: number
}

/**
 * The options Jest passes to a transformer.
 * @public
 */
export interface JestTransformOptions<Config = unknown> {
  readonly cacheFS: Map<string, string>
  readonly config: JestProjectConfigLike
  readonly configString: string
  readonly transformerConfig: Config
  readonly instrument: boolean
  readonly supportsDynamicImport: boolean
  readonly supportsExportNamespaceFrom: boolean
  readonly supportsStaticESM: boolean
  readonly supportsTopLevelAwait: boolean
}

/**
 * What a Jest transformer returns.
 * @public
 */
export interface JestTransformedSource {
  code: string
  map?: JestRawSourceMap | string | null
}

/**
 * A Jest transformer with a sync `process` (babel-jest, ts-jest).
 * @public
 */
export interface JestSyncTransformer<Config = unknown> {
  canInstrument?: boolean
  getCacheKey?(source: string, path: string, options: JestTransformOptions<Config>): string
  getCacheKeyAsync?(
    source: string,
    path: string,
    options: JestTransformOptions<Config>,
  ): Promise<string>
  process(
    source: string,
    path: string,
    options: JestTransformOptions<Config>,
  ): JestTransformedSource
  processAsync?(
    source: string,
    path: string,
    options: JestTransformOptions<Config>,
  ): Promise<JestTransformedSource>
}

/**
 * A Jest transformer with a required `processAsync`.
 * @public
 */
export interface JestAsyncTransformer<Config = unknown>
  extends Omit<JestSyncTransformer<Config>, 'process' | 'processAsync'> {
  process?(
    source: string,
    path: string,
    options: JestTransformOptions<Config>,
  ): JestTransformedSource
  processAsync(
    source: string,
    path: string,
    options: JestTransformOptions<Config>,
  ): Promise<JestTransformedSource>
}

/**
 * A Jest transformer. Real `@jest/transform` transformers assign to it.
 * @public
 */
export type JestTransformer<Config = unknown> =
  | JestSyncTransformer<Config>
  | JestAsyncTransformer<Config>

/**
 * A module exporting `createTransformer` (Jest's transformer factory form).
 * @public
 */
export interface JestTransformerFactory<T extends JestTransformer> {
  createTransformer(config?: unknown): T | Promise<T>
}

/**
 * One entry of Jest's `transform` config, in order.
 * @public
 */
export interface JestTransformRule {
  readonly pattern: RegExp
  readonly module: string
  readonly config: unknown
}
