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
import { pathText } from './keys.ts'

const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/

/**
 * POSIX and relative to `rootDir`. A path that is already relative is only re-slashed. Windows
 * paths (`C:\work`, `\\server\share`) are made relative with Windows rules, whatever the host, so a
 * Windows run converts the same way on a POSIX machine.
 */
export function toRelativePath(rootDir: string, file: string): string {
  let relative = file
  if (WINDOWS_ABSOLUTE.test(rootDir) && WINDOWS_ABSOLUTE.test(file)) {
    relative = path.win32.relative(rootDir, file)
  } else if (path.isAbsolute(file)) {
    relative = path.relative(rootDir, file)
  }
  return relative.replace(/\\/g, '/')
}

/** What a failure message stands for when the runner has none (`throw { status: 404 }`). */
export const NO_ERROR_MESSAGE = '<no message>'

export function contextOf(options: ConvertOptions): NormalizeContext {
  return options.extraRoots === undefined
    ? { rootDir: options.rootDir }
    : { rootDir: options.rootDir, extraRoots: options.extraRoots }
}

/**
 * Hands out `TestIdentity` values for one file. `dupIndex` counts earlier tests whose path prints
 * the same in a test key, in the order the runner listed them, so every key is unique.
 * (`describe('a', () => it('b'))` and `it('a › b')` print the same.)
 */
export function identityAllocator(file: string): (titles: readonly string[]) => TestIdentity {
  const seen = new Map<string, number>()
  return (titles) => {
    const key = pathText(titles)
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
  readonly durationMs?: number
  /** Builds the file's tests once its identity allocator exists. */
  readonly tests: (
    allocate: (titles: readonly string[]) => TestIdentity,
  ) => readonly NormalizedTest[]
}

/**
 * A failed file with no tests is `crashed`: a syntax error, a missing import. A failed file whose
 * tests did not fail failed outside them (a hook after the last test), and keeps its status. Both
 * keep the file's message as `fileError`. When a test failed, the message repeats that failure.
 */
export function assembleFile(raw: RawFile, options: ConvertOptions): NormalizedFile {
  const file = toRelativePath(options.rootDir, raw.path)
  const tests = raw.tests(identityAllocator(file))
  const crashed = raw.status === 'failed' && tests.length === 0
  const status: FileStatus = crashed ? 'crashed' : raw.status
  const failedOutsideTests = raw.status === 'failed' && !tests.some((t) => t.status === 'failed')
  const fileError: NormalizedError | undefined =
    failedOutsideTests && raw.message.trim() !== ''
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
