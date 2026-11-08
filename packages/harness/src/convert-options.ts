import type { RunEnvironment, SnapshotFileState } from '@provino/types'
import type { SidecarEntry } from './internal/sidecar-format.ts'

/**
 * What every converter needs besides the runner's own JSON.
 * @public
 */
export interface ConvertOptions {
  /** Absolute. Test paths become POSIX paths relative to it, and `<root>` in normalized text. */
  readonly rootDir: string
  /** Other roots to replace with `<root>` in normalized text. */
  readonly extraRoots?: readonly string[]
  /** The corpus or fixture id, e.g. `date-fns@a9739fb` or `recorder/outcomes-basic`. */
  readonly suite: string
  /** The runner's version, e.g. `30.5.2`. */
  readonly runnerVersion: string
  /** ISO 8601. Defaults to the runner's own `startTime`. */
  readonly startedAt?: string
  readonly env: RunEnvironment
  /**
   * The snapshot files the run left, hashed by the caller (the JSON has counters only). Without
   * them the run reports counters and no files.
   */
  readonly snapshotFiles?: readonly SnapshotFileState[]
  /** Collects the ids of the normalization rules that changed any text. */
  readonly fired?: Set<string>
  /**
   * The run's console output, as a sidecar reporter wrote it (`parseSidecar`). Each entry is split
   * into lines (Track 12 F1), each line is normalized, and the lines go to the test the entry
   * names, else to its file. Without it the run has no `console` anywhere.
   */
  readonly console?: readonly SidecarEntry[]
}

/**
 * Options for `convertJest`.
 * @public
 */
export type JestConvertOptions = ConvertOptions

/**
 * Options for `convertVitest`.
 * @public
 */
export type VitestConvertOptions = ConvertOptions
