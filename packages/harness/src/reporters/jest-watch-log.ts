// The run log of a watch session (B23c Phase 3): one JSON line per run, what the watch goldens'
// `runs` capture holds. Loaded by absolute path from the config the recorder writes (and, for
// Provino's side of a comparison, from `provino jest --reporters`), so it imports Node builtins
// only, as the sidecar reporters do.
import { appendFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The environment variable that names the run log when the reporter's options give no
 * `outputFile`.
 * @public
 */
export const WATCH_LOG_ENV: string = 'PROVINO_WATCH_LOG'

/**
 * A test as the run log keeps it.
 * @public
 */
export interface WatchLogTest {
  readonly fullName: string
  readonly status: string
}

/**
 * A test file as the run log keeps it: its path relative to the root (POSIX separators), how it
 * ended (`crashed` for a file that failed outside a test, `failed`, `skipped` or `passed`), and its
 * tests in Jest's order (the order they were declared).
 * @public
 */
export interface WatchLogFile {
  readonly path: string
  readonly status: 'crashed' | 'failed' | 'skipped' | 'passed'
  readonly tests: readonly WatchLogTest[]
}

/**
 * One run: its files sorted by path (Jest lists them in the order they finished), the snapshot
 * counters a watch key changes, and whether a key interrupted it.
 * @public
 */
export interface WatchLogEntry {
  readonly files: readonly WatchLogFile[]
  readonly snapshot: {
    readonly added: number
    readonly updated: number
    readonly unmatched: number
  }
  readonly wasInterrupted: boolean
}

/**
 * The part of Jest's `AggregatedResult` the log reads, so a test can hand it a plain object.
 * @public
 */
export interface WatchLogResults {
  readonly testResults: readonly {
    readonly testFilePath: string
    readonly numFailingTests: number
    readonly skipped: boolean
    readonly testExecError?: unknown
    readonly failureMessage?: string | null
    readonly testResults: readonly WatchLogTest[]
  }[]
  readonly snapshot: {
    readonly added: number
    readonly updated: number
    readonly unmatched: number
  }
  readonly wasInterrupted: boolean
}

function byPath(a: WatchLogFile, b: WatchLogFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

/**
 * The run log's entry for one run of Jest, with each file's path relative to `rootDir`.
 * @public
 */
export function watchLogEntry(results: WatchLogResults, rootDir: string): WatchLogEntry {
  const files = results.testResults.map((file): WatchLogFile => {
    const failedOutside =
      file.testExecError !== undefined && file.testExecError !== null && file.numFailingTests === 0
    return {
      path: path.relative(rootDir, file.testFilePath).split(path.sep).join('/'),
      status: failedOutside
        ? 'crashed'
        : file.numFailingTests > 0
          ? 'failed'
          : file.skipped
            ? 'skipped'
            : 'passed',
      tests: file.testResults.map((test) => ({ fullName: test.fullName, status: test.status })),
    }
  })
  return {
    files: files.toSorted(byPath),
    snapshot: {
      added: results.snapshot.added,
      updated: results.snapshot.updated,
      unmatched: results.snapshot.unmatched,
    },
    wasInterrupted: results.wasInterrupted,
  }
}

/**
 * What the reporter takes from its config entry (`['<path>', { outputFile }]`).
 * @public
 */
export interface WatchLogOptions {
  readonly outputFile?: string
}

/**
 * Appends one line to the run log at the end of every run (`onRunComplete`, which Jest calls for
 * an interrupted run too). The reporter never empties the file: Jest makes its reporters again for
 * every run (`runJest` calls `createTestScheduler` each time), so whoever starts the session
 * starts the file empty, and the log then holds every run of it.
 * @public
 */
export default class JestWatchLogReporter {
  readonly #file: string
  readonly #rootDir: string

  /** Jest passes its global config, then the reporter's options. */
  constructor(globalConfig: { readonly rootDir: string }, options?: WatchLogOptions) {
    const file = options?.outputFile ?? process.env[WATCH_LOG_ENV]
    if (file === undefined || file === '') {
      throw new Error(
        `the Provino watch-log reporter needs a file to write: set ${WATCH_LOG_ENV} or pass { outputFile }`,
      )
    }
    this.#file = file
    this.#rootDir = globalConfig.rootDir
  }

  onRunComplete(_contexts: unknown, results: WatchLogResults): void {
    appendFileSync(this.#file, `${JSON.stringify(watchLogEntry(results, this.#rootDir))}\n`)
  }

  /** Jest asks every reporter for a failure that should fail the run; writing never fails one. */
  getLastError(): undefined {
    return undefined
  }
}
