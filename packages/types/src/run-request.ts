import type { Diagnostic } from './dialect.ts'

/**
 * One file filter from a command line: a positional Jest pattern (`regex`, matched against the
 * path), a Vitest substring (`substring`), an exact path (`--runTestsByPath`, `path`), or a
 * `file.ts:12` form (`pathLine`, with `line`).
 * @public
 */
export interface FileFilter {
  readonly kind: 'regex' | 'substring' | 'path' | 'pathLine'
  readonly value: string
  readonly line?: number
}

/**
 * What a command line asks a run to be. Each dialect's CLI parses its own flags into one of these
 * (Track 11 F5), and `provino` layers it over a project: a field that is absent leaves the
 * project's own setting.
 *
 * A flag the dialect understands but the coordinator has no backend for yet (`--watch`,
 * `--coverage`, `--bail`) is not here: the parser reports it as an `error` diagnostic naming the
 * flag and the task that will build it, so nothing is silently ignored.
 * @public
 */
export interface RunRequest {
  /** What to do: run the tests, or print what would run (`--listTests`, `--showConfig`, `--clearCache`). */
  readonly mode: 'run' | 'list-files' | 'show-config' | 'clear-cache'
  /** `--listTests --json`: print a JSON array instead of one path per line. */
  readonly json: boolean
  readonly fileFilters: readonly FileFilter[]
  /** `-t`: a regular expression's source, matched against a test's full name. */
  readonly namePattern?: string
  /** `-w`, `--maxWorkers`: a count or a percentage of the cores. */
  readonly maxWorkers?: number | `${number}%`
  /** `-i`, `--runInBand`. */
  readonly inBand: boolean
  /** `--workerThreads`: workers are threads, not processes. */
  readonly workerThreads?: boolean
  /** `--ci` / `--no-ci`; absent when not given (the environment decides). */
  readonly ci?: boolean
  /** `-u`, `--updateSnapshot`: rewrite the snapshots that differ; absent when not given. */
  readonly update?: boolean
  /** `--passWithNoTests`; absent when not given (the project's setting stands). */
  readonly passWithNoTests?: boolean
  /** `--cache` / `--no-cache`; absent when not given. */
  readonly cache?: boolean
  /** `-c`, `--config`: a path, or a JSON text where the dialect accepts one. */
  readonly configPath?: string
}

/**
 * A dialect's command line: its parser and the translation of what it parsed into a `RunRequest`.
 * `Argv` is the dialect's own parsed form (Jest's `argv`), which its config reader also takes.
 * @public
 */
export interface CliDialect<Argv = unknown> {
  /**
   * Parses the arguments after the command name. Bad input throws (the dialect's own error, with
   * the runner's message where the runner has one); a flag that is understood but unsupported, or
   * accepted but not applied, comes back as a diagnostic.
   */
  parse(args: readonly string[]): {
    readonly argv: Argv
    readonly diagnostics: readonly Diagnostic[]
  }
  toRunRequest(argv: Argv): RunRequest
}
