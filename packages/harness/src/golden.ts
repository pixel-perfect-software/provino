import path from 'node:path'
import type {
  ConsoleEntry,
  FileStatus,
  NormalizedError,
  NormalizedFile,
  NormalizedRun,
  NormalizedTest,
  RunnerId,
  SchemaVersion,
  SkipReason,
  SnapshotCounters,
  SnapshotFileState,
  TestIdentity,
  TestStatus,
  TraceEntry,
} from '@provino/types'
import type { FixtureRunner } from './fixture.ts'
import { GOLDENS_DIR } from './fixture.ts'

/**
 * A failure as a golden keeps it: no `raw`, because the runner's own text carries stack frames
 * and absolute paths that differ between machines.
 * @public
 */
export interface GoldenError {
  readonly name?: string
  readonly message: string
  readonly matcher?: string
  readonly userFrame?: string
}

/**
 * A test as a golden keeps it: no duration.
 * @public
 */
export interface GoldenTest {
  readonly id: TestIdentity
  readonly status: TestStatus
  readonly skipReason?: SkipReason
  readonly errors: readonly GoldenError[]
  readonly passingAssertions?: number
  readonly retries?: number
  readonly location?: { readonly line: number; readonly column: number }
  readonly console?: readonly ConsoleEntry[]
  readonly expectedToFail?: boolean
}

/**
 * A file as a golden keeps it: no duration.
 * @public
 */
export interface GoldenFile {
  readonly file: string
  readonly status: FileStatus
  readonly fileError?: GoldenError
  readonly tests: readonly GoldenTest[]
  readonly console?: readonly ConsoleEntry[]
  readonly trace?: readonly TraceEntry[]
}

/**
 * What the recorder commits to `__goldens__/<runner>.json`: a `NormalizedRun` without the parts
 * that change between runs and machines (`startedAt`, `env`, every duration and every `raw`).
 * @public
 */
export interface Golden {
  readonly schemaVersion: SchemaVersion
  readonly runner: RunnerId
  readonly runnerVersion: string
  /** The fixture id, `area/behaviour`. */
  readonly suite: string
  readonly files: readonly GoldenFile[]
  readonly snapshots?: {
    readonly counters: SnapshotCounters
    readonly files: readonly SnapshotFileState[]
  }
  readonly runErrors: readonly GoldenError[]
  readonly success: boolean
}

function goldenError(error: NormalizedError): GoldenError {
  return {
    ...(error.name === undefined ? {} : { name: error.name }),
    message: error.message,
    ...(error.matcher === undefined ? {} : { matcher: error.matcher }),
    ...(error.userFrame === undefined ? {} : { userFrame: error.userFrame }),
  }
}

function goldenConsole(entries: readonly ConsoleEntry[]): ConsoleEntry[] {
  return entries.map((entry) => ({
    stream: entry.stream,
    ...(entry.level === undefined ? {} : { level: entry.level }),
    text: entry.text,
  }))
}

function goldenTrace(entries: readonly TraceEntry[]): TraceEntry[] {
  return entries.map((entry) => ({
    kind: entry.kind,
    owner: [...entry.owner],
    ...(entry.label === undefined ? {} : { label: entry.label }),
    ...(entry.outcome === undefined ? {} : { outcome: entry.outcome }),
  }))
}

function goldenTest(test: NormalizedTest): GoldenTest {
  return {
    id: { file: test.id.file, path: [...test.id.path], dupIndex: test.id.dupIndex },
    status: test.status,
    ...(test.skipReason === undefined ? {} : { skipReason: test.skipReason }),
    errors: test.errors.map(goldenError),
    ...(test.passingAssertions === undefined ? {} : { passingAssertions: test.passingAssertions }),
    ...(test.retries === undefined ? {} : { retries: test.retries }),
    ...(test.location === undefined
      ? {}
      : { location: { line: test.location.line, column: test.location.column } }),
    ...(test.console === undefined ? {} : { console: goldenConsole(test.console) }),
    ...(test.expectedToFail === undefined ? {} : { expectedToFail: test.expectedToFail }),
  }
}

function goldenFile(file: NormalizedFile): GoldenFile {
  return {
    file: file.file,
    status: file.status,
    ...(file.fileError === undefined ? {} : { fileError: goldenError(file.fileError) }),
    tests: file.tests.map(goldenTest),
    ...(file.console === undefined ? {} : { console: goldenConsole(file.console) }),
    ...(file.trace === undefined ? {} : { trace: goldenTrace(file.trace) }),
  }
}

/**
 * Projects a run onto what a golden keeps. The keys are built in a fixed order, so
 * `serializeGolden` is byte-stable.
 * @public
 */
export function toGolden(run: NormalizedRun): Golden {
  const { counters, files } = run.snapshots ?? {}
  return {
    schemaVersion: run.schemaVersion,
    runner: run.runner,
    runnerVersion: run.runnerVersion,
    suite: run.suite,
    files: run.files.map(goldenFile),
    ...(counters === undefined || files === undefined
      ? {}
      : {
          snapshots: {
            counters: {
              added: counters.added,
              matched: counters.matched,
              unmatched: counters.unmatched,
              updated: counters.updated,
              unchecked: counters.unchecked,
              total: counters.total,
              filesAdded: counters.filesAdded,
              filesRemoved: counters.filesRemoved,
              filesUnmatched: counters.filesUnmatched,
              filesUpdated: counters.filesUpdated,
            },
            files: files.map((f) => ({ file: f.file, sha256: f.sha256 })),
          },
        }),
    runErrors: run.runErrors.map(goldenError),
    success: run.success,
  }
}

/**
 * The bytes of a golden file: 2-space JSON and a trailing newline.
 * @public
 */
export function serializeGolden(golden: Golden): string {
  return `${JSON.stringify(golden, null, 2)}\n`
}

/**
 * Where a fixture's golden for a runner lives: `<fixture>/__goldens__/<runner>.json`.
 * @public
 */
export function goldenPath(fixtureDir: string, runner: FixtureRunner): string {
  return path.join(fixtureDir, GOLDENS_DIR, `${runner}.json`)
}
