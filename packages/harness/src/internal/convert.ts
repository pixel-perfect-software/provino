// Pieces both converters share: path handling, identity allocation, and the assembly of tests, files
// and runs. A converter supplies only what is particular to its runner.
import path from 'node:path'
import type {
  ConsoleEntry,
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
import { createNormalizer, type Normalizer, testKey } from '../normalize.ts'
import { SCHEMA_VERSION } from '../schema.ts'
import { byFile, finiteNumber } from './guards.ts'
import { pathText } from './keys.ts'
import { WINDOWS_ABSOLUTE } from './paths.ts'
import type { SidecarEntry } from './sidecar-format.ts'

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
 * A file-level message without the frames of the runner's own packages. Jest builds the error of an
 * empty file (`Your test suite must contain at least one test.`) inside `@jest/core`, and which of
 * its frames the text carries, and how they are indented, differs from run to run (an `emittery`
 * frame and a native `Array.map` one came and went between two recordings of one fixture), so a
 * golden that held them drifted without the runner having changed. A frame in `node_modules/`, and
 * a native one directly after it, is the runner's, never the project's.
 */
function withoutRunnerFrames(message: string): string {
  const kept: string[] = []
  let afterRunner = false
  for (const line of message.split('\n')) {
    const frame = /^\s+at /.test(line)
    if (frame && line.includes('node_modules/')) {
      afterRunner = true
      continue
    }
    if (frame && afterRunner && /\((?:<anonymous>|native)\)\s*$/.test(line)) continue
    afterRunner = false
    kept.push(line)
  }
  return kept.join('\n')
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
    failedOutsideTests && raw.message.trim() !== ''
      ? errorOf(withoutRunnerFrames(raw.message), conversion)
      : undefined
  return {
    file,
    status,
    ...(fileError === undefined ? {} : { fileError }),
    tests,
    ...(raw.durationMs === undefined ? {} : { durationMs: raw.durationMs }),
  }
}

/**
 * A sidecar entry's text as lines: split on `\n`, because Vitest merges adjacent writes to one
 * stream and Jest doesn't (Track 12 F1). A trailing newline ends the last line rather than starting
 * an empty one, so `console.log('')` is one empty line under both runners.
 */
export function consoleLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines
}

/** Memoizes a one-argument function of a string, for text a run repeats many times. */
export function memo(of: (text: string) => string): (text: string) => string {
  const seen = new Map<string, string>()
  return (text) => {
    let out = seen.get(text)
    if (out === undefined) {
      out = of(text)
      seen.set(text, out)
    }
    return out
  }
}

// Keys in the order `parseNormalizedRun` builds them, so a converted run and the same run read
// back from its file serialize alike (a golden passes console entries through as they are).
function entriesOf(entry: SidecarEntry, normalize: (line: string) => string): ConsoleEntry[] {
  return consoleLines(entry.text).map((line) => ({
    stream: entry.stream,
    text: normalize(line),
    ...(entry.level === undefined ? {} : { level: entry.level }),
  }))
}

/**
 * Puts the sidecar's console output (`ConvertOptions.console`) into the files: an entry that names
 * a test goes to that test, matched by its test key; any other entry, and one whose test the
 * runner's JSON doesn't list, goes to its file. An entry for a file the run doesn't list, or for no
 * file at all, has nowhere to go in the model and is dropped. Lines keep the sidecar's order. Files
 * and tests that printed nothing get no `console`. A suite repeats its lines and its file paths
 * many times, so each distinct line is normalized once, and each path made relative once: `fired`
 * only grows during a conversion, so a repeated line has added its rules already.
 */
export function attachConsole(
  files: readonly NormalizedFile[],
  conversion: Conversion,
): NormalizedFile[] {
  const entries = conversion.options.console
  if (entries === undefined || entries.length === 0) return [...files]
  const normalize = memo((line) => conversion.normalizer.text(line, conversion.options.fired))
  const relative = memo((file) => toRelativePath(conversion.options.rootDir, file))
  const listed = new Set(files.map((file) => file.file))
  const known = new Set(files.flatMap((file) => file.tests.map((test) => testKey(test.id))))
  const fileLines = new Map<string, ConsoleEntry[]>()
  const testLines = new Map<string, ConsoleEntry[]>()
  for (const entry of entries) {
    if (entry.file === undefined) continue
    const file = relative(entry.file)
    if (!listed.has(file)) continue
    const key = entry.test === undefined ? undefined : testKey({ file, ...entry.test })
    const [target, at] = key !== undefined && known.has(key) ? [testLines, key] : [fileLines, file]
    const lines = entriesOf(entry, normalize)
    const existing = target.get(at)
    if (existing === undefined) target.set(at, lines)
    else existing.push(...lines)
  }
  return files.map((file) => {
    const own = fileLines.get(file.file)
    const tests = file.tests.map((test) => {
      const lines = testLines.get(testKey(test.id))
      return lines === undefined ? test : { ...test, console: lines }
    })
    return { ...file, tests, ...(own === undefined ? {} : { console: own }) }
  })
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
