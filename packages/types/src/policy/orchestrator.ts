import type { ChangedFilesProvider, DependencyExtractorFactory } from '../affected.ts'
import type { JsonValue } from '../clone-safe.ts'
import type { ProcessObject } from '../environment.ts'
import type { IsolationTier } from '../isolation.ts'
import type { Behaviour } from './behaviour.ts'

/**
 * Worker pool kinds (Track 9): child processes, worker threads, or in the coordinator's own
 * process (`inline`, Jest's `--runInBand`).
 * @public
 */
export type PoolKind = 'forks' | 'threads' | 'inline'

/**
 * The environment a test file asks for, as the coordinator sees it.
 * @public
 */
export interface EnvironmentRequest {
  readonly name: string
  /** The project's options for the environment (Jest's `testEnvironmentOptions`, wrapped by the adapter). */
  readonly options?: { readonly [key: string]: JsonValue }
  readonly conditions?: readonly string[]
}

/**
 * Returns the resolver export conditions for an environment (Track 8, consumed through Track 3).
 * @public
 */
export type EnvironmentConditions = (env: EnvironmentRequest) => readonly string[]

/**
 * The two configs a global setup or teardown function is called with under the
 * `global-and-project-config` signature, as the dialect's config reader built them (Jest's
 * `GlobalConfig` and `ProjectConfig`). They are coordinator-local: a hook runs in the coordinator
 * and these never cross to a worker, so they are not JSON and may hold what the hook should see (a
 * class instance, a function).
 * @public
 */
export interface GlobalSetupArgs {
  readonly globalConfig: object
  readonly projectConfig: object
}

/**
 * What a global hook that throws, or is no function, is reported as: the `Error` this returns,
 * whatever the hook threw. `hook` is the one that failed and `path` its module. A reporter prints
 * the error's `name` and `message` as the header and the `    at ` lines of its `stack` as the
 * frames. The function may return the thrown error itself, rewritten.
 * @public
 */
export type GlobalSetupFailure = (
  thrown: unknown,
  context: { readonly hook: 'globalSetup' | 'globalTeardown'; readonly path: string },
) => Error

/**
 * The `orchestrator` slice, read by `@provino/orchestrator` (Track 9): discovery, scheduling,
 * bail, watch, exit codes, and each file's isolation tier and environment.
 * @public
 */
export interface OrchestratorPolicy {
  /** Default test globs. Also Track 11's `defaultInclude`. Jest: `__tests__` plus `.test`/`.spec`. Vitest: `.test`/`.spec` only. research: track-01 L224, track-11 L524 */
  readonly include: readonly string[]
  /** Default excluded globs. research: track-01 L224 */
  readonly exclude: readonly string[]
  /**
   * When the failed-test count is checked against `--bail`. Replaces Track 1's
   * `bail.{unit,checkpoint}`, Track 5's `bail.granularity` and Track 11's `bailUnit` (§6).
   * Jest: `file`. Vitest: `test`. research: track-09 L557
   */
  readonly bail: { readonly checkAfter: 'file' | 'test' }
  /** When watch mode is on without a flag. Also Track 9's `watch.autoInTty`. Jest: `never`. Vitest: `tty-not-ci`. research: track-01 L226, track-09 L561 */
  readonly watchDefault: 'never' | 'tty-not-ci'
  /** Watch mode settings (Track 9 `watch.*`). */
  readonly watch: {
    /** What the first watch run covers. Jest: `changed` (`all` with `--watchAll`). Vitest: `all`. research: track-09 L560 */
    readonly initialRun: 'changed' | 'all'
  }
  /**
   * Where the files a change touched come from (`-o`, `--changedSince`, `--lastCommit`,
   * `--changedFilesWithAncestor`, watch's own selection): a provider the coordinator loads, so the
   * commands it runs (git, hg, sl) are the dialect's. Jest: `jestChangedFiles`
   * (`@provino/dialect-jest/affected`; jest-changed-files rebuilt). Neutral and Vitest: `null`, so a
   * selection by changed files is refused with `ORCH_NOT_IMPLEMENTED` (T11.16). research: track-09
   */
  readonly changedFiles: Behaviour<ChangedFilesProvider> | null
  /** Which files a change reaches: how the dependency graph is read (Track 9, affected-test selection). */
  readonly affected: {
    /**
     * What reads a file's import specifiers: a `Behaviour` the coordinator loads, or `null` for the
     * lexer of `@provino/loader/graph`. Jest: `jestDependencyExtractor` (haste's regex extractor;
     * which edges count is observable). Neutral and Vitest: `null`.
     */
    readonly extractor: Behaviour<DependencyExtractorFactory> | null
    /**
     * How a mock reaches the files that use it: `dir` is the mock directory's name, `adjacent`
     * counts `<dir>/<basename>` beside a resolved file as an edge to it, and `byName` counts the
     * root mock found by name for a specifier that doesn't resolve. Jest: `__mocks__`, both on.
     * Neutral: `__mocks__`, adjacent only. `null`: no mock edges.
     */
    readonly mockEdges: {
      readonly dir: string
      readonly adjacent: boolean
      readonly byName: boolean
    } | null
    /**
     * What a change to the project's own inputs (its config file, setup files, global setup and
     * teardown, environment module, root `package.json`, lockfiles and tsconfig) selects.
     * `project-inputs`: every file of the project. `none`: only what the graph reaches (Jest's).
     */
    readonly invalidateAll: 'project-inputs' | 'none'
    /**
     * Where the graph comes from. `static`: the specifiers in the sources. `recorded-then-static`:
     * a test file whose recorded `deps` are newer than every dependency uses the record, else the
     * sources. Jest: `static`. Neutral: `recorded-then-static`.
     */
    readonly graph: 'static' | 'recorded-then-static'
  }
  /**
   * What an `include` glob (Jest's `testMatch`) is matched against. Jest: `absolute-path`, so a
   * relative glob needs a leading `**\/` or `<rootDir>`. Vitest: `root-relative-path`. Ours.
   * Evidence: `policy/orchestrator-match-path` (U2, B14c).
   */
  readonly globMatchesOn: 'absolute-path' | 'root-relative-path'
  /**
   * What a file whose tests are only skipped and todo ones, with at least one todo, ends as: Jest
   * marks a suite skipped only when every test is pending, so a todo test makes it `pass`; Vitest's
   * rule is not recorded yet. Neutral: `skip`, since nothing ran. Evidence: `cli/report-todo-only`
   * (B21c, DV50).
   */
  readonly todoOnlyFile: 'pass' | 'skip'
  /**
   * Whether the worker records where each `console` call was made (`ConsoleEvent.origin`: the
   * call site as one `at …` line, the way Jest's `BufferedConsole` keeps one). Jest: `stack`.
   * Neutral and Vitest: `none` (their text has no such line). Evidence:
   * `cli/report-default` (the `at Object.log (console.test.ts:4:11)` lines).
   */
  readonly consoleOrigin: 'stack' | 'none'
  /** Whether a run that finds no tests passes. Jest: `false`. Vitest: `false`. research: track-01 L227 */
  readonly passWithNoTests: boolean
  /**
   * Exit codes. Also Track 9's `exitCode.failure`. Jest: 1/1/1, and 1 for `usage`. Vitest: 1/1/1,
   * and 1 for `usage`. research: track-01 L228, track-09 L563. `usage` is the code for a command
   * line or config the runner refuses before any test is found (U3, B14c); the neutral value is
   * 2, Track 9's `ExitCode.UsageError`, and both dialects record 1
   * (`cli/unknown-flag`, `cli/bad-config`).
   */
  readonly exitCodes: {
    readonly failure: number
    readonly noTests: number
    readonly unhandled: number
    readonly usage: number
  }
  /** What an unhandled error does to the run. Jest: `fail-run`. Vitest: `fail-run`. research: track-01 L229 */
  readonly unhandledErrors: 'fail-run' | 'ignore'
  /** Default coverage provider. Also Track 8's `coverage.defaultProvider`. Jest: `istanbul`. Vitest: `v8`. research: track-01 L230, track-08 L516 */
  readonly coverageProvider: 'v8' | 'istanbul'
  /**
   * Default coverage reporters. Also Track 8's `coverage.defaultReporters`.
   * Jest: json, text, lcov, clover. Vitest: text, html, clover, json. research: track-01 L230, track-08 L519
   */
  readonly coverageReporters: readonly string[]
  /** A test slower than this is reported as slow, in ms. Jest: 5000. Vitest: 300. research: track-01 L231 */
  readonly slowTestThresholdMs: number
  /**
   * Isolation tier when config sets none: a default, plus overrides per environment name. Track 1's
   * scalar, widened to carry Track 2's `defaultTier(environment)` as data.
   * Jest: `registry` (DECISIONS D6; Track 1 and Track 2 said `realm`). Vitest: `registry`; `realm`
   * for `jsdom` and `happy-dom`. research: track-01 L232, track-02 L455
   */
  readonly isolationDefault: {
    readonly default: IsolationTier
    readonly byEnvironment: Readonly<Record<string, IsolationTier>>
  }
  /** Default test environment. Jest: `node`. Vitest: `node`. research: track-01 L232 */
  readonly envDefault: string
  /**
   * The `process` a test file sees, which its environment installs. `per-file`: a copy of the
   * worker's `process` made for the file, as jest-util's `createProcessObject` makes one: the same
   * members and prototype, but listeners of its own (none when the file starts, and the worker
   * never emits on it, so an `exit` or `uncaughtException` listener a file adds is never called
   * and never reaches the next file), a copy of `env` (a change stays in the file, and a child
   * process started without an `env` option doesn't see it), a `send` that does nothing, and
   * `getBuiltinModule('process')` the copy. `shared`: the worker's own `process`, so listeners
   * and `env` changes outlive the file. Jest: `per-file` (recorded: `env/process-per-file-listeners`,
   * `env/process-per-file-env`, `env/process-setup-listener-per-file`, `env/process-uncaught-listener`,
   * `env/process-identity`). Vitest: `shared` (its node environment builds no global; it isolates
   * files by process instead). Neutral: `per-file`.
   */
  readonly processObject: ProcessObject
  /**
   * Docblock pragmas that pick a file's environment. Also Track 11's `environmentPragma`.
   * Jest: `['jest-environment']`. Vitest: `['vitest-environment', 'jest-environment']`. research: track-08 L515
   */
  readonly environmentPragmas: readonly string[]
  /**
   * Resolver export conditions per environment. Jest: the environment's `exportConditions()`
   * (jsdom `['browser']`, node `['node', 'node-addons']`). Vitest: `['node']` for the built-ins.
   * research: track-08 L514
   */
  readonly environmentConditions: Behaviour<EnvironmentConditions>
  /** Default pool. Jest: `forks` (`threads` with `workerThreads`). Vitest: `forks`. research: track-09 L555 */
  readonly pool: { readonly default: PoolKind }
  /** Whether small runs go in band automatically. Jest: `true` (≤20 fast files). Vitest: `false`. research: track-09 L556 */
  readonly runInBand: { readonly auto: boolean }
  /**
   * How `--shard=i/n` splits the files when no file has a time in the timings file. `sha1-slice`:
   * the files sorted by the sha1 of their path, then contiguous slices by count (Jest's, and
   * Vitest's by its source). `path-slice`: the files sorted by path, then contiguous slices by
   * count. With timings, every dialect cuts contiguous slices of the path-sorted files by predicted
   * time. Jest: `sha1-slice` (recorded: `cli/shard-1-of-3` to `3-of-3`). Vitest: `sha1-slice`
   * (its source, not recorded). Neutral: `path-slice`. research: track-09 L558
   */
  readonly shard: { readonly fallback: 'sha1-slice' | 'path-slice' }
  /** Whether files with no timing history run first. Jest: `true`. Vitest: `true`. research: track-09 L559 */
  readonly sequence: { readonly unknownFirst: boolean }
  /**
   * The `globalSetup` module's signature: `(globalConfig, projectConfig)`
   * (`global-and-project-config`), or `(project)` returning a teardown (`project-with-teardown`).
   * Track 9 names the values `'jest' | 'vitest'`; renamed so neutral code never compares a runner
   * name. Jest: `global-and-project-config`. Vitest: `project-with-teardown`. research: track-09 L564
   */
  readonly globalSetup: {
    readonly signature: 'global-and-project-config' | 'project-with-teardown'
    /**
     * The order the teardowns run in, against the setups': the same (`in-order`) or the opposite
     * (`reverse`). Jest: `in-order` (`runGlobalHook` walks one list for both; recorded by
     * `cli/global-setup-projects`). Vitest: `reverse`. Evidence for Vitest: its source
     * (`core.ts` closes the projects last to first).
     */
    readonly teardownOrder: 'in-order' | 'reverse'
    /**
     * What a hook that throws, or is no function, is reported as. Jest: the thrown `Error` with
     * its message rewritten in place to `Jest: Got error running {hook} - {path}, reason:
     * {message}` (its class and frames kept); for a value that is no `Error`, or whose message
     * can't be rewritten, a new `Error` with that text, the value printed by pretty-format three
     * levels deep (recorded by `cli/global-setup-throws`, `-typeerror`, `-object` and `-string`).
     * Neutral: an `Error` that names the hook and the path, with the thrown error as its `cause`.
     * Vitest: the neutral behaviour, until T11.16 records what its source raises.
     */
    readonly failure: Behaviour<GlobalSetupFailure>
  }
}
