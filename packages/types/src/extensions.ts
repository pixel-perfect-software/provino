// Track 1 §Extension points: ten contracts, each owned by a track. B04 replaced the v0 shapes
// with the owners' types (environment and coverage: Track 8; resolver: Track 3; pool, reporter
// and sequencer: Track 9). `Transformer` keeps Track 1's shape on Track 3's records, since Track 3
// defines no user transformer beyond Jest's. `MatcherSet` is Track 7's (`expect.ts`, B08).
// `SnapshotSerializer` is v0 until T7.10, `WatchPlugin` until T9.11. Contribution and
// ProvinoPlugin are Track 1's and stay.
import type { ProjectConfig } from './config.ts'
import type { CoverageProvider } from './coverage.ts'
import type { Environment } from './environment.ts'
import type { MatcherSet } from './expect.ts'
import type { Reporter, Sequencer, TransportFactory } from './orchestrator.ts'
import type { Resolver } from './resolve.ts'
import type { SourceMapV3, TransformRequest } from './transform.ts'

/**
 * Where code runs: a test worker, the coordinator, or either.
 * @public
 */
export type RunsIn = 'worker' | 'coordinator' | 'both'

/**
 * A pretty-format plugin for snapshots (Track 7 owns the full contract). Runs in the worker.
 * @public
 */
export interface SnapshotSerializer {
  test(value: unknown): boolean
  serialize(value: unknown, ...rest: never[]): string
}

/**
 * A transformer's output.
 * @beta
 */
export interface TransformerOutput {
  readonly code: string
  readonly map: SourceMapV3 | null
  readonly format: 'esm' | 'cjs'
}

/**
 * A source transformer a plugin contributes. Runs in either process.
 * @beta
 */
export interface Transformer {
  /** Files it handles. */
  readonly filter: RegExp
  /** Everything besides the source that changes the output. */
  cacheKey(request: TransformRequest): string
  transform(request: TransformRequest): TransformerOutput | Promise<TransformerOutput>
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
  /** Any environment; its options are checked by the environment itself. */
  readonly environment: Environment<string, unknown, object>
  readonly transformer: Transformer
  readonly resolver: Resolver
  readonly pool: TransportFactory
  readonly reporter: Reporter
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
