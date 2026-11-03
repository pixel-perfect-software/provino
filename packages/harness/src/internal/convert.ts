// Pieces both converters share: path handling, identity allocation, and the assembly of tests, files
// and runs. A converter supplies only what is particular to its runner.
import path from 'node:path'
import type {
  FileStatus,
  NormalizedError,
  NormalizedFile,
  NormalizedRun,
  NormalizedTest,
  SnapshotCounters,
  TestIdentity,
  TestStatus,
} from '@provino/types'
import type { ConvertOptions } from '../convert-options.ts'
import { createNormalizer, type Normalizer } from '../normalize.ts'
import { SCHEMA_VERSION } from '../schema.ts'
import { byFile, finiteNumber } from './guards.ts'
import { pathText } from './keys.ts'
import { WINDOWS_ABSOLUTE } from './paths.ts'

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
const NO_ERROR_MESSAGE = '<no message>'

/** One conversion: its options, and a normalizer for them that is built once, not per failure. */
export interface Conversion {
  readonly options: ConvertOptions
  readonly normalizer: Normalizer
}

export function startConversion(options: ConvertOptions): Conversion {
  const normalizer = createNormalizer(
    options.extraRoots === undefined
      ? { rootDir: options.rootDir }
      : { rootDir: options.rootDir, extraRoots: options.extraRoots },
  )
  return { options, normalizer }
}

/** A failure's text, normalized; the rules that fired are collected in `options.fired`. */
export function errorOf(text: string, conversion: Conversion, matcher?: string): NormalizedError {
  return conversion.normalizer.error(text, matcher, conversion.options.fired)
}

/**
 * A test's failures. A runner's JSON can hold a null where a thrown non-Error left nothing to
 * print; it becomes one error with the message `<no message>`. `matcherOf` names the matcher of the
 * failure at an index, for a runner whose JSON says.
 */
export function errorsOf(
  messages: readonly (string | null)[] | null | undefined,
  conversion: Conversion,
  matcherOf?: (index: number) => string | undefined,
): NormalizedError[] {
  return (messages ?? []).map((message, index) =>
    errorOf(message ?? NO_ERROR_MESSAGE, conversion, matcherOf?.(index)),
  )
}

type Allocate = (titles: readonly string[]) => TestIdentity

/**
 * Hands out `TestIdentity` values for one file. `dupIndex` counts earlier tests with the same title
 * path, in the order the runner listed them. `pathText` prints two paths alike only when they are
 * the same, so counting by it counts by path.
 */
export function identityAllocator(file: string): Allocate {
  const seen = new Map<string, number>()
  return (titles) => {
    const key = pathText(titles)
    const dupIndex = seen.get(key) ?? 0
    seen.set(key, dupIndex + 1)
    return { file, path: titles, dupIndex }
  }
}

/** The fields of a runner's assertion that Jest and Vitest both write. */
interface AssertionFields {
  readonly ancestorTitles: readonly string[]
  readonly title: string
  readonly failureMessages?: readonly (string | null)[] | null
  readonly duration?: number | null
  readonly location?: { readonly line: number; readonly column: number } | null
}

/** What a converter adds to the shared test: its status, and what only its runner reports. */
export interface TestParts {
  readonly status: TestStatus
  readonly matcherOf?: (index: number) => string | undefined
  readonly extra?: Pick<NormalizedTest, 'passingAssertions' | 'retries' | 'expectedToFail'>
}

/**
 * Builds a test from a runner's assertion. A skipped test carries `unknown` as the reason: the JSON
 * doesn't say why it was skipped.
 */
export function assembleTest(
  assertion: AssertionFields,
  allocate: Allocate,
  conversion: Conversion,
  parts: TestParts,
): NormalizedTest {
  const duration = finiteNumber(assertion.duration)
  const { location } = assertion
  return {
    id: allocate([...assertion.ancestorTitles, assertion.title]),
    status: parts.status,
    ...(parts.status === 'skipped' ? { skipReason: 'unknown' as const } : {}),
    errors: errorsOf(assertion.failureMessages, conversion, parts.matcherOf),
    ...parts.extra,
    ...(duration === undefined ? {} : { durationMs: duration }),
    ...(location ? { location: { line: location.line, column: location.column } } : {}),
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
  readonly tests: (allocate: Allocate) => readonly NormalizedTest[]
}

/**
 * A file entry in the `--json` layout both runners write: `name`, `message`, `startTime`,
 * `endTime` and `assertionResults`. The converter gives the status, whose words differ.
 */
export function jsonFile<A>(
  file: {
    readonly name: string
    readonly message: string
    readonly startTime: number
    readonly endTime: number
    readonly assertionResults: readonly A[]
  },
  status: RawFile['status'],
  convertAssertion: (assertion: A, allocate: Allocate) => NormalizedTest,
): RawFile {
  const duration = finiteNumber(file.endTime - file.startTime)
  return {
    path: file.name,
    status,
    message: file.message,
    ...(duration === undefined ? {} : { durationMs: duration }),
    tests: (allocate) => file.assertionResults.map((a) => convertAssertion(a, allocate)),
  }
}

/**
 * A failed file with no tests is `crashed`: a syntax error, a missing import. A failed file whose
 * tests did not fail failed outside them (a hook after the last test), and keeps its status. Both
 * keep the file's message as `fileError`. When a test failed, the message repeats that failure.
 */
export function assembleFile(raw: RawFile, conversion: Conversion): NormalizedFile {
  const file = toRelativePath(conversion.options.rootDir, raw.path)
  const tests = raw.tests(identityAllocator(file))
  const crashed = raw.status === 'failed' && tests.length === 0
  const status: FileStatus = crashed ? 'crashed' : raw.status
  const failedOutsideTests = raw.status === 'failed' && !tests.some((t) => t.status === 'failed')
  const fileError =
    failedOutsideTests && raw.message.trim() !== '' ? errorOf(raw.message, conversion) : undefined
  return {
    file,
    status,
    ...(fileError === undefined ? {} : { fileError }),
    tests,
    ...(raw.durationMs === undefined ? {} : { durationMs: raw.durationMs }),
  }
}

/** The ten snapshot totals, copied by name: both runners write more than the model keeps. */
export function countersOf(totals: SnapshotCounters): SnapshotCounters {
  return {
    added: totals.added,
    matched: totals.matched,
    unmatched: totals.unmatched,
    updated: totals.updated,
    unchecked: totals.unchecked,
    total: totals.total,
    filesAdded: totals.filesAdded,
    filesRemoved: totals.filesRemoved,
    filesUnmatched: totals.filesUnmatched,
    filesUpdated: totals.filesUpdated,
  }
}

/** Files sorted by path (runners list them in completion order); tests keep declaration order. */
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
  return {
    schemaVersion: SCHEMA_VERSION,
    runner: parts.runner,
    runnerVersion: options.runnerVersion,
    suite: options.suite,
    startedAt: options.startedAt ?? new Date(parts.startTime).toISOString(),
    env: options.env,
    files: parts.files.toSorted(byFile),
    snapshots: {
      counters: parts.counters,
      files: (options.snapshotFiles ?? []).toSorted(byFile),
    },
    runErrors: parts.runErrors,
    success: parts.success,
  }
}
