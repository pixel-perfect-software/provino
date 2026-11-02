// The result model (Track 12 §Types and public API). Every runner's output converts to a
// NormalizedRun: the harness converts Jest and Vitest JSON, and Provino's `normalized-json`
// reporter writes it natively. Rebuilt from the track doc; the spike's source no longer exists.

/**
 * The result-model schema version. This package exports types only, so the runtime constant is
 * `SCHEMA_VERSION` in `@provino/harness`.
 * @public
 */
export type SchemaVersion = 1

/**
 * Which runner produced a run. Provino runs name their dialect.
 * @public
 */
export type RunnerId = 'jest' | 'vitest' | 'provino:jest' | 'provino:vitest' | (string & {})

/**
 * A test's outcome. `notRun` is a test that was collected but never started (Vitest's `pending`).
 * @public
 */
export type TestStatus = 'passed' | 'failed' | 'skipped' | 'todo' | 'notRun'

/**
 * Why a test was skipped, when the runner says so.
 * @public
 */
export type SkipReason =
  | 'modifier'
  | 'only-filter'
  | 'name-filter'
  | 'condition'
  | 'dynamic'
  | 'unknown'

/**
 * A test's identity across runners: its file, its title path, and its index among tests with the
 * same file and path. The key form is `file::a › b#0` (`testKey` in `@provino/harness`).
 * @public
 */
export interface TestIdentity {
  /** POSIX, relative to the corpus root. */
  readonly file: string
  /** Describe titles, then the test title. Never joined. */
  readonly path: readonly string[]
  /** 0-based among tests with the same file and path, in declaration order. */
  readonly dupIndex: number
}

/**
 * A failure, normalized for comparison: no stack, no ANSI, no code frame.
 * @public
 */
export interface NormalizedError {
  /** `Error`, `AssertionError`, `TypeError`... */
  readonly name?: string
  /** Normalized message, with no stack, ANSI or code frame. */
  readonly message: string
  /** `toBe`, `toEqual`... when the runner reports it. */
  readonly matcher?: string
  /** The first user frame, as `<root>/src/a.test.ts:12:5`. */
  readonly userFrame?: string
  /** The text as the runner emitted it; for drill-down only, never compared. */
  readonly raw: string
}

/**
 * One line of console output. Multi-line writes are split into one entry per line.
 * @public
 */
export interface ConsoleEntry {
  readonly stream: 'stdout' | 'stderr'
  readonly level?: string
  readonly text: string
}

/**
 * One step of a hook-and-test trace.
 * @public
 */
export interface TraceEntry {
  readonly kind:
    | 'hook:beforeAll'
    | 'hook:afterAll'
    | 'hook:beforeEach'
    | 'hook:afterEach'
    | 'test:start'
    | 'test:end'
    | 'mark'
  /** The describe path (hooks) or the full test path (tests). */
  readonly owner: readonly string[]
  /** The hook's ordinal within its owner, or the mark text. */
  readonly label?: string
  readonly outcome?: 'ok' | 'error'
}

/**
 * One test's normalized result.
 * @public
 */
export interface NormalizedTest {
  readonly id: TestIdentity
  readonly status: TestStatus
  readonly skipReason?: SkipReason
  readonly errors: readonly NormalizedError[]
  readonly passingAssertions?: number
  readonly retries?: number
  /** Recorded, never compared. */
  readonly durationMs?: number
  /** 1-based line and column. */
  readonly location?: { readonly line: number; readonly column: number }
  readonly console?: readonly ConsoleEntry[]
  /** `test.failing` (Jest) or `test.fails` (Vitest). */
  readonly expectedToFail?: boolean
}

/**
 * A test file's outcome. `crashed` means the file failed before or outside its tests (a syntax
 * error, a missing import), so it reports no tests.
 * @public
 */
export type FileStatus = 'passed' | 'failed' | 'crashed' | 'skipped'

/**
 * One test file's normalized result.
 * @public
 */
export interface NormalizedFile {
  /** POSIX, relative to the corpus root. */
  readonly file: string
  readonly status: FileStatus
  readonly fileError?: NormalizedError
  readonly tests: readonly NormalizedTest[]
  /** Console output that can't be attributed to a test. */
  readonly console?: readonly ConsoleEntry[]
  readonly trace?: readonly TraceEntry[]
  readonly durationMs?: number
}

/**
 * The machine and toolchain a run or benchmark happened on (Track 12 R5: CPU model, core count,
 * RAM, kernel, Node version and every runner's version).
 * @public
 */
export interface RunEnvironment {
  /** `process.platform`. */
  readonly os: string
  /** The kernel release (`os.release()`). */
  readonly osRelease: string
  readonly arch: string
  readonly cpuModel: string
  /** Logical cores. */
  readonly cpuCount: number
  /** Total RAM in MiB. */
  readonly memoryMb: number
  /** `process.version`. */
  readonly node: string
  /** Every runner's version, by runner: `{ jest: '30.5.2' }`. */
  readonly runners: Readonly<Record<string, string>>
  readonly ci: boolean
}

/**
 * A run's snapshot totals, as Jest and Vitest both report them.
 * @public
 */
export interface SnapshotCounters {
  readonly added: number
  readonly matched: number
  readonly unmatched: number
  readonly updated: number
  /** Obsolete snapshots the run didn't check. */
  readonly unchecked: number
  readonly total: number
  readonly filesAdded: number
  readonly filesRemoved: number
  readonly filesUnmatched: number
  readonly filesUpdated: number
}

/**
 * A snapshot file as a run left it, for snapshot byte parity (Track 12 R2).
 * @public
 */
export interface SnapshotFileState {
  /** POSIX, relative to the corpus root. */
  readonly file: string
  /** Hex sha256 of the file's bytes. */
  readonly sha256: string
}

/**
 * One whole run of one runner over one suite, normalized.
 * @public
 */
export interface NormalizedRun {
  readonly schemaVersion: SchemaVersion
  readonly runner: RunnerId
  readonly runnerVersion: string
  /** The corpus id, e.g. `date-fns@a9739fb`. */
  readonly suite: string
  readonly startedAt: string
  readonly env: RunEnvironment
  readonly files: readonly NormalizedFile[]
  readonly snapshots?: {
    readonly counters: SnapshotCounters
    readonly files: readonly SnapshotFileState[]
  }
  readonly runErrors: readonly NormalizedError[]
  readonly success: boolean
}
