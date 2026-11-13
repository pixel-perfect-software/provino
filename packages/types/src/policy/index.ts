import type { DataOnly, DeepPartial } from './behaviour.ts'
import type { CorePolicy } from './core.ts'
import type { CoveragePolicy } from './coverage.ts'
import type { ExpectPolicy } from './expect.ts'
import type { LazyPolicy } from './lazy.ts'
import type { MockPolicy } from './mock.ts'
import type { ModulePolicy } from './module.ts'
import type { OrchestratorPolicy } from './orchestrator.ts'
import type { ReportPolicy } from './report.ts'
import type { SnapshotPolicy } from './snapshot.ts'
import type { TimersPolicy } from './timers.ts'

/**
 * Every policy slice, by name. Each slice is read by one package, which imports only its own
 * slice type (monorepo-architecture.md, rule 3).
 * @public
 */
export interface PolicySlices {
  readonly core: CorePolicy
  readonly lazy: LazyPolicy
  readonly mock: MockPolicy
  readonly timers: TimersPolicy
  readonly module: ModulePolicy
  readonly snapshot: SnapshotPolicy
  readonly expect: ExpectPolicy
  readonly orchestrator: OrchestratorPolicy
  readonly report: ReportPolicy
  readonly coverage: CoveragePolicy
}

/**
 * A slice name.
 * @public
 */
export type SliceName = keyof PolicySlices

/**
 * The whole resolved policy. Only `policy`, `config`, `orchestrator` and the dialects handle it;
 * every other package takes its own slice.
 * @public
 */
export type Policy = { readonly [K in SliceName]: PolicySlices[K] }

/**
 * One layer of policy: a dialect's, a project's or a facade's. Any key may be left out.
 * @public
 */
export type PolicyOverrides = { readonly [K in SliceName]?: DeepPartial<PolicySlices[K]> }

/**
 * What crosses coordinator → worker: data keys as values, behaviour keys as `ModuleRef` only.
 * @public
 */
export type SerializedPolicy = { readonly [K in SliceName]: DataOnly<PolicySlices[K]> }

export type {
  AnyFunction,
  Behaviour,
  DataOnly,
  DeepPartial,
  ModuleRef,
  PolicyAtom,
} from './behaviour.ts'
export type {
  CorePolicy,
  EachTableKind,
  FormatEachTitle,
  FormatValue,
  HookKind,
  HookOrder,
  OrderHooks,
} from './core.ts'
export type { CoveragePolicy } from './coverage.ts'
export type { ExpectPolicy, MatcherTableFactory } from './expect.ts'
export type { LazyPolicy } from './lazy.ts'
export type { MockCleanupStep, MockMessages, MockPolicy } from './mock.ts'
export type { FormatMapperMiss, MapperMiss, ModuleMessages, ModulePolicy } from './module.ts'
export type {
  EnvironmentConditions,
  EnvironmentRequest,
  GlobalSetupArgs,
  OrchestratorPolicy,
  PoolKind,
  ReviveGlobalSetupArgs,
} from './orchestrator.ts'
export type { ReportPolicy } from './report.ts'
export type {
  LegacySnapshotSerializer,
  ResolveSnapshotPath,
  SnapshotKey,
  SnapshotMessageInfo,
  SnapshotMessages,
  SnapshotPlugin,
  SnapshotPolicy,
  SnapshotPrinter,
  SnapshotPrinterFactory,
  SnapshotSerializeOptions,
} from './snapshot.ts'
export type { TimersPolicy } from './timers.ts'
