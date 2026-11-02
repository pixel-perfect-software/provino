// Pieces both converters share: path handling, identity allocation, status-independent builders.
import path from 'node:path'
import type {
  FileStatus,
  NormalizedError,
  NormalizedFile,
  NormalizedRun,
  NormalizedTest,
  RunEnvironment,
  SnapshotCounters,
  SnapshotFileState,
  TestIdentity,
  TestStatus,
} from '@provino/types'
import type { ConvertOptions } from '../convert-options.ts'
import { type NormalizeContext, normalizeError } from '../normalize.ts'
import { SCHEMA_VERSION } from '../schema.ts'
import { compareStrings } from './guards.ts'

/** POSIX and relative to `rootDir`. A path that is already relative is only re-slashed. */
export function toRelativePath(rootDir: string, file: string): string {
  const relative = path.isAbsolute(file) ? path.relative(rootDir, file) : file
  return relative.split(path.sep).join('/').replace(/\\/g, '/')
}

export function contextOf(options: ConvertOptions): NormalizeContext {
  return options.extraRoots === undefined
    ? { rootDir: options.rootDir }
    : { rootDir: options.rootDir, extraRoots: options.extraRoots }
}

/**
 * Hands out `TestIdentity` values for one file. `dupIndex` counts earlier tests with the same
 * title path, in the order the runner listed them.
 */
export function identityAllocator(file: string): (titles: readonly string[]) => TestIdentity {
  const seen = new Map<string, number>()
  return (titles) => {
    const key = titles.join('\u0000')
    const dupIndex = seen.get(key) ?? 0
    seen.set(key, dupIndex + 1)
    return { file, path: titles, dupIndex }
  }
}

/** What a converter extracts from one runner file entry, before the shared assembly. */
export interface RawFile {
  /** Absolute or relative path as the runner printed it. */
  readonly path: string
  readonly status: 'passed' | 'failed' | 'skipped'
  /** The file-level failure text, `''` when there is none. */
  readonly message: string
  /** The runner flagged an execution error for the file itself. */
  readonly hasExecError: boolean
  readonly durationMs?: number
  /** Builds the file's tests once its identity allocator exists. */
  readonly tests: (
    allocate: (titles: readonly string[]) => TestIdentity,
  ) => readonly NormalizedTest[]
}

/** A failed file with no tests failed outside them: a syntax error, a missing import. */
export function assembleFile(raw: RawFile, options: ConvertOptions): NormalizedFile {
  const file = toRelativePath(options.rootDir, raw.path)
  const tests = raw.tests(identityAllocator(file))
  const crashed = raw.status === 'failed' && tests.length === 0
  const status: FileStatus = crashed ? 'crashed' : raw.status
  const fileError: NormalizedError | undefined =
    (crashed || raw.hasExecError) && raw.message.trim() !== ''
      ? normalizeError(raw.message, contextOf(options), undefined, options.fired)
      : undefined
  return {
    file,
    status,
    ...(fileError === undefined ? {} : { fileError }),
    tests,
    ...(raw.durationMs === undefined ? {} : { durationMs: raw.durationMs }),
  }
}

export function sortFiles(files: readonly NormalizedFile[]): NormalizedFile[] {
  return files.toSorted((a, b) => compareStrings(a.file, b.file))
}

export function snapshotSection(
  counters: SnapshotCounters,
  files: readonly SnapshotFileState[] | undefined,
): NonNullable<NormalizedRun['snapshots']> {
  return {
    counters,
    files: (files ?? []).toSorted((a, b) => compareStrings(a.file, b.file)),
  }
}

export function startedAtOf(options: ConvertOptions, startTime: number): string {
  return options.startedAt ?? new Date(startTime).toISOString()
}

export function runOf(
  parts: {
    readonly runner: string
    readonly files: readonly NormalizedFile[]
    readonly startTime: number
    readonly counters: SnapshotCounters
    readonly runErrors: readonly NormalizedError[]
    readonly success: boolean
  },
  options: ConvertOptions,
): NormalizedRun {
  const env: RunEnvironment = options.env
  return {
    schemaVersion: SCHEMA_VERSION,
    runner: parts.runner,
    runnerVersion: options.runnerVersion,
    suite: options.suite,
    startedAt: startedAtOf(options, parts.startTime),
    env,
    files: sortFiles(parts.files),
    snapshots: snapshotSection(parts.counters, options.snapshotFiles),
    runErrors: parts.runErrors,
    success: parts.success,
  }
}

/** `skipped` carries `unknown` as the reason: the JSON doesn't say why a test was skipped. */
export function skipReasonOf(status: TestStatus): NormalizedTest['skipReason'] | undefined {
  return status === 'skipped' ? 'unknown' : undefined
}
