// Benchmark records (Track 12 §Types → site data contract, R5). `@provino/bench` writes them and
// the site charts them. Brief 2 puts them here rather than in `@provino/harness/site`, which
// re-exports them.
import type { IsolationTier } from './isolation.ts'
import type { RunEnvironment, RunnerId } from './result.ts'

/**
 * Where a benchmark ran (`.claude/rules/benchmarks.md`): `local` is any laptop or CI box and is a
 * development signal only; `desktop` is the pinned-core container on Tyler's desktop (Phase 0–1
 * provisional numbers); `pinned` is the dedicated bench server. Only `pinned` decides GO.
 * @public
 */
export type BenchLabel = 'local' | 'desktop' | 'pinned'

/**
 * The commit a record was measured at.
 * @public
 */
export interface RunRef {
  readonly sha: string
  /** ISO 8601. */
  readonly date: string
  readonly release?: string
}

/**
 * A subject's isolation: one of Provino's tiers, or whatever the runner does by default.
 * @public
 */
export type IsolationMode = IsolationTier | 'runner-default'

/**
 * One thing being measured: a runner, its version and isolation, and how to reproduce it.
 * @public
 */
export interface BenchSubject {
  readonly runner: RunnerId | 'bun' | 'rstest' | 'node:test'
  readonly version: string
  readonly isolation: IsolationMode
  /** The exact command, reproducible from the repo root. */
  readonly command: string
  readonly configPath?: string
}

/**
 * Wall-clock statistics over a subject's timed runs (Track 12 R5).
 * @public
 */
export interface WallStats {
  readonly runs: number
  readonly medianMs: number
  readonly q1Ms: number
  readonly q3Ms: number
  readonly minMs: number
  readonly maxMs: number
  /** Bootstrap 95% CI of the median (2,000 resamples). */
  readonly ciLowMs: number
  readonly ciHighMs: number
  /** Coefficient of variation: standard deviation over mean. */
  readonly cv: number
  /** Every timed run, in run order. None are ever dropped. */
  readonly samplesMs: readonly number[]
}

/**
 * One subject on one suite with one cache state.
 * @public
 */
export interface BenchResult {
  /** The suite, e.g. `app-500`. */
  readonly benchId: string
  readonly subject: BenchSubject
  readonly cache: 'cold' | 'warm'
  readonly wall: WallStats
  /** Peak RSS summed over the process tree, in MiB. */
  readonly peakRssMb?: number
  readonly cpuUserMs?: number
  readonly cpuSysMs?: number
  /** Instruction count, for regression tracking only. */
  readonly instructions?: number
  /** False if any run failed. Failing runs are never charted as speed. */
  readonly ok: boolean
}

/**
 * One benchmark session: every result, the machine, and the commit.
 * @public
 */
export interface BenchRecord {
  readonly schemaVersion: 1
  readonly label: BenchLabel
  readonly ref: RunRef
  readonly machine: RunEnvironment & { readonly id: string; readonly governor?: string }
  readonly results: readonly BenchResult[]
}
