// Track 3 §Types → shared records, plus the Jest transformer types (structurally identical to
// `@jest/transform` 30). The pipeline itself (`Pipeline`, `PipelineOptions`, `CacheOptions`,
// `ImportRewrite`) belongs to `@provino/transform` (B05). Track 2's `TransformedModule` is
// folded into `TransformRecord` (its one extra field is `hasTopLevelAwait`).
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
  /** Whether the module uses top-level await (sync `require` of it must throw). */
  readonly hasTopLevelAwait: boolean
  readonly diagnostics: readonly TransformDiagnostic[]
  readonly cacheKey: string
  readonly fromCache: boolean
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
