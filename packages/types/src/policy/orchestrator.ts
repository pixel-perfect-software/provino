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
  readonly conditions?: readonly string[]
}

/**
 * Returns the resolver export conditions for an environment (Track 8, consumed through Track 3).
 * @public
 */
export type EnvironmentConditions = (env: EnvironmentRequest) => readonly string[]

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
  /** Whether a run that finds no tests passes. Jest: `false`. Vitest: `false`. research: track-01 L227 */
  readonly passWithNoTests: boolean
  /** Exit codes. Also Track 9's `exitCode.failure`. Jest: 1/1/1. Vitest: 1/1/1. research: track-01 L228, track-09 L563 */
  readonly exitCodes: {
    readonly failure: number
    readonly noTests: number
    readonly unhandled: number
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
  /** How files are sharded without timing data. Jest: `sha1-slice`. Vitest: `sha1-slice`. research: track-09 L558 */
  readonly shard: { readonly fallback: 'sha1-slice' }
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
  }
}
