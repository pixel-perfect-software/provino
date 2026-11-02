// Track 1 §Extension points: the ten contracts at v0. Each owning track replaces its contract's
// v0 shape with the full one (B04: Environment, CoverageProvider, Transformer, Resolver, Pool,
// ReporterV1, Sequencer, WatchPlugin; B08: MatcherSet, SnapshotSerializer). Contribution and
// ProvinoPlugin are Track 1's and stay.
import type { ProjectConfig } from './config.ts'
import type { ModuleRef } from './policy/behaviour.ts'

/**
 * Where code runs: a test worker, the coordinator, or either.
 * @public
 */
export type RunsIn = 'worker' | 'coordinator' | 'both'

/**
 * A matcher's verdict.
 * @public
 */
export interface MatcherResult {
  readonly pass: boolean
  readonly message: () => string
}

/**
 * One matcher: `(received, ...expected) → { pass, message }`. Parameters are `never` so a
 * matcher may type them (`(received: number, floor: number) => …`).
 * @public
 */
export type Matcher = (
  received: never,
  ...expected: never[]
) => MatcherResult | Promise<MatcherResult>

/**
 * A set of matchers by name (Track 7 owns the full contract). Runs in the worker.
 * @public
 */
export interface MatcherSet {
  readonly [name: string]: Matcher
}

/**
 * A pretty-format plugin for snapshots (Track 7 owns the full contract). Runs in the worker.
 * @public
 */
export interface SnapshotSerializer {
  test(value: unknown): boolean
  serialize(value: unknown, ...rest: never[]): string
}

/**
 * What an environment's `setup` receives (Track 8 owns the full contract).
 * @public
 */
export interface EnvironmentContext {
  readonly options: Readonly<Record<string, unknown>>
}

/**
 * A set-up environment.
 * @public
 */
export interface EnvironmentInstance {
  readonly global: object
  reset?(): void | Promise<void>
  teardown(): void | Promise<void>
}

/**
 * A test environment such as node or jsdom (Track 8 owns the full contract). Runs in the worker.
 * @public
 */
export interface Environment {
  readonly name: string
  readonly scope: 'file' | 'worker'
  setup(context: EnvironmentContext): EnvironmentInstance | Promise<EnvironmentInstance>
}

/**
 * A file handed to a transformer.
 * @public
 */
export interface TransformInput {
  readonly filename: string
  readonly source: string
}

/**
 * A transformer's output.
 * @public
 */
export interface TransformOutput {
  readonly code: string
  readonly map: string | null
  readonly format: 'esm' | 'cjs'
}

/**
 * A source transformer (Track 3 owns the full contract). Runs in either process.
 * @public
 */
export interface Transformer {
  readonly filter: RegExp
  cacheKey(input: TransformInput): string
  transform(input: TransformInput): TransformOutput | Promise<TransformOutput>
}

/**
 * A module resolver (Track 3 owns the full contract). Runs in either process. Returns `null`
 * when it can't resolve the specifier.
 * @public
 */
export interface Resolver {
  resolve(
    specifier: string,
    from: string,
    conditions: readonly string[],
  ): string | null | Promise<string | null>
}

/**
 * Options for one pool worker.
 * @public
 */
export interface PoolWorkerOptions {
  readonly id: number
  readonly entry: string
}

/**
 * One worker in a pool.
 * @public
 */
export interface PoolWorker {
  send(message: unknown): void
  on(event: 'message' | 'error' | 'exit', listener: (value: unknown) => void): void
  start(): Promise<void>
  stop(): Promise<void>
}

/**
 * A worker pool (Track 9 owns the full contract). Runs in the coordinator.
 * @public
 */
export interface Pool {
  createWorker(options: PoolWorkerOptions): PoolWorker
}

/**
 * A reporter (Track 9 owns the full contract and the event types). Runs in the coordinator.
 * @public
 */
export interface ReporterV1<Event = unknown, Summary = unknown> {
  readonly version: 'v1'
  onEvent(event: Event): void | Promise<void>
  onEnd(summary: Summary): void | Promise<void>
}

/**
 * A test file the sequencer orders.
 * @public
 */
export interface FileSpec {
  readonly file: string
  readonly project: string
}

/**
 * Orders and shards test files (Track 9 owns the full contract). Runs in the coordinator.
 * @public
 */
export interface Sequencer {
  sort(specs: readonly FileSpec[]): readonly FileSpec[] | Promise<readonly FileSpec[]>
  shard?(
    specs: readonly FileSpec[],
    shard: { readonly index: number; readonly count: number },
  ): readonly FileSpec[]
}

/**
 * A coverage provider (Track 8 owns the full contract): a worker-side collector, loaded by
 * `ModuleRef`, and coordinator-side merge and report.
 * @public
 */
export interface CoverageProvider {
  readonly collector: ModuleRef
  merge(results: readonly unknown[]): unknown
  report(merged: unknown): void | Promise<void>
}

/**
 * A watch-mode key binding (Track 9 owns the full contract). Runs in the coordinator.
 * @public
 */
export interface WatchPlugin {
  readonly key: string
  readonly prompt: string
  onKey(key: string): void | Promise<void>
  onRerun?(): void | Promise<void>
}

/**
 * Each contribution kind and the contract its module exports.
 * @public
 */
export interface ContributionContracts {
  readonly environment: Environment
  readonly transformer: Transformer
  readonly resolver: Resolver
  readonly pool: Pool
  readonly reporter: ReporterV1
  readonly sequencer: Sequencer
  readonly 'snapshot-serializer': SnapshotSerializer
  readonly matchers: MatcherSet
  readonly 'coverage-provider': CoverageProvider
  readonly 'watch-plugin': WatchPlugin
}

/**
 * A contribution kind.
 * @public
 */
export type ContributionKind = keyof ContributionContracts

/**
 * Where each contribution kind runs (Track 1 §Extension points).
 * @public
 */
export interface ContributionPlacement {
  readonly environment: 'worker'
  readonly transformer: 'both'
  readonly resolver: 'both'
  readonly pool: 'coordinator'
  readonly reporter: 'coordinator'
  readonly sequencer: 'coordinator'
  readonly 'snapshot-serializer': 'worker'
  readonly matchers: 'worker'
  readonly 'coverage-provider': 'both'
  readonly 'watch-plugin': 'coordinator'
}

/**
 * One extension, registered by module so it loads in the process it runs in. `runsIn` is fixed
 * by `kind` (an `environment` always runs in the worker), even in a list of mixed kinds. Which
 * export of `module` holds the contract is set by the owning track (B04, B08).
 *
 * `options` cross to that process with the module name, so they must be clone-safe. The type
 * can't require that (a `CloneSafe` bound on `Options` is circular); the function that builds
 * contributions (`definePlugin`, T1.4) checks it with `Options & CloneSafe<Options>`.
 * @public
 */
export type Contribution<
  Kind extends ContributionKind = ContributionKind,
  Options = unknown,
> = Kind extends ContributionKind
  ? {
      readonly kind: Kind
      readonly runsIn: ContributionPlacement[Kind]
      readonly module: string
      readonly options: Options
    }
  : never

/**
 * A plugin: a bundle of contributions plus three coordinator hooks.
 * @public
 */
export interface ProvinoPlugin<Name extends string = string> {
  readonly name: Name
  readonly contributions?: readonly Contribution[]
  /** Runs before config is resolved; may return a changed config. */
  readonly config?: (
    config: ProjectConfig,
  ) => ProjectConfig | undefined | Promise<ProjectConfig | undefined>
  readonly configResolved?: (config: ProjectConfig) => void | Promise<void>
  readonly teardown?: () => void | Promise<void>
}

/**
 * Plugin option types by plugin name. Plugin packages augment it:
 * `declare module '@provino/types' { interface PluginRegistry { msw: MswOptions } }`.
 * @public
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by plugin packages (declaration merging).
export interface PluginRegistry {}
