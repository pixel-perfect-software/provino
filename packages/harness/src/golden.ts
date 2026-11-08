import { readFile } from 'node:fs/promises'
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
import type { FixtureProfile } from './fixture.ts'
import { GOLDENS_DIR } from './fixture.ts'
import { countersOf } from './internal/convert.ts'

/**
 * What happened to a golden: `written` and `unchanged` when recording; `matches`, `drift` and
 * `missing` when checking.
 * @public
 */
export type RecordOutcome = 'written' | 'unchanged' | 'matches' | 'drift' | 'missing'

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
  /** The recording profile, only when it is not the runner's own (`vitest-list`). */
  readonly profile?: FixtureProfile
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
  /**
   * The steps the fixture's `trace(step)` calls recorded, in call order. Absent when nothing was
   * traced. Not `files[].trace`, which is the result model's structured hook trace.
   */
  readonly trace?: readonly string[]
  /**
   * What a black-box run (`run` in `fixture.json`) showed from outside, normalized like the rest.
   * Absent for every other fixture.
   */
  readonly observed?: GoldenObserved
}

/**
 * What a black-box run showed: the exit code, the streams and the files `run.capture` names (a
 * file's text, or `null` when the run left none there). Only the captured keys are present.
 * @public
 */
export interface GoldenObserved {
  readonly exitCode?: number | null
  readonly stdout?: string
  readonly stderr?: string
  readonly files?: Readonly<Record<string, string | null>>
}

/**
 * What a recording adds to a run's golden: the profile it ran under, the steps it traced and, for
 * a black-box run, what it showed.
 * @public
 */
export interface GoldenExtras {
  readonly profile?: FixtureProfile
  readonly trace?: readonly string[]
  readonly observed?: GoldenObserved
}

function goldenError(error: NormalizedError): GoldenError {
  return {
    ...(error.name === undefined ? {} : { name: error.name }),
    message: error.message,
    ...(error.matcher === undefined ? {} : { matcher: error.matcher }),
    ...(error.userFrame === undefined ? {} : { userFrame: error.userFrame }),
  }
}

// A golden keeps a field list of its own at each level that drops something (`raw`, `durationMs`,
// `startedAt`, `env`): that fixes the key order and keeps a future producer's extra fields out.
// A part that is already the right shape is passed through.
function goldenTest(test: NormalizedTest): GoldenTest {
  return {
    id: test.id,
    status: test.status,
    ...(test.skipReason === undefined ? {} : { skipReason: test.skipReason }),
    errors: test.errors.map(goldenError),
    ...(test.passingAssertions === undefined ? {} : { passingAssertions: test.passingAssertions }),
    ...(test.retries === undefined ? {} : { retries: test.retries }),
    ...(test.location === undefined ? {} : { location: test.location }),
    ...(test.console === undefined ? {} : { console: test.console }),
    ...(test.expectedToFail === undefined ? {} : { expectedToFail: test.expectedToFail }),
  }
}

function goldenFile(file: NormalizedFile): GoldenFile {
  return {
    file: file.file,
    status: file.status,
    ...(file.fileError === undefined ? {} : { fileError: goldenError(file.fileError) }),
    tests: file.tests.map(goldenTest),
    ...(file.console === undefined ? {} : { console: file.console }),
    ...(file.trace === undefined ? {} : { trace: file.trace }),
  }
}

/**
 * Projects a run onto what a golden keeps. The keys are built in a fixed order, so
 * `serializeGolden` is byte-stable. `extras.profile` is kept only when it differs from the run's
 * runner, and `extras.trace` only when it is not empty.
 * @public
 */
export function toGolden(run: NormalizedRun, extras: GoldenExtras = {}): Golden {
  const { snapshots } = run
  const { profile, trace, observed } = extras
  return {
    schemaVersion: run.schemaVersion,
    runner: run.runner,
    ...(profile === undefined || profile === run.runner ? {} : { profile }),
    runnerVersion: run.runnerVersion,
    suite: run.suite,
    files: run.files.map(goldenFile),
    ...(snapshots === undefined
      ? {}
      : { snapshots: { counters: countersOf(snapshots.counters), files: snapshots.files } }),
    runErrors: run.runErrors.map(goldenError),
    success: run.success,
    ...(trace === undefined || trace.length === 0 ? {} : { trace }),
    ...(observed === undefined ? {} : { observed: observedInOrder(observed) }),
  }
}

/** `observed` with its keys in a fixed order, so the golden's bytes don't depend on the caller. */
function observedInOrder(observed: GoldenObserved): GoldenObserved {
  return {
    ...(observed.exitCode === undefined ? {} : { exitCode: observed.exitCode }),
    ...(observed.stdout === undefined ? {} : { stdout: observed.stdout }),
    ...(observed.stderr === undefined ? {} : { stderr: observed.stderr }),
    ...(observed.files === undefined ? {} : { files: observed.files }),
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
 * Where a fixture's golden for a profile lives: `<fixture>/__goldens__/<profile>.json`.
 * @public
 */
export function goldenPath(fixtureDir: string, profile: FixtureProfile): string {
  return path.join(fixtureDir, GOLDENS_DIR, `${profile}.json`)
}

/**
 * The recorded golden of a fixture for a profile. The file is the recorder's own output and the
 * corpus checks are its readers; a malformed one fails the check that reads it.
 * @internal
 */
export async function readGolden(fixtureDir: string, profile: FixtureProfile): Promise<Golden> {
  return JSON.parse(await readFile(goldenPath(fixtureDir, profile), 'utf8')) as Golden
}
