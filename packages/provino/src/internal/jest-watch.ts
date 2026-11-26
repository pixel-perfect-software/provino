// `provino jest --watch` and `--watchAll` (B23c Phase 8, T9.11): Jest's watch driver
// (`@provino/dialect-jest/node`'s `startJestWatch`) over the orchestrator's watch session. This is
// the host the driver is given: each run selects its files as Jest's `runJest` does (the changed
// files under `--watch`, everything under `--watchAll`, the patterns a key set, the failed tests of
// the last run under `f`), builds the reporters again (Jest calls `createTestScheduler` for every
// run), runs on the session's warm pool and hands the driver Jest's `AggregatedResult`.
import { realpathSync } from 'node:fs'
import type { ResolvedProject } from '@provino/config'
import {
  createJestResults,
  JEST_CLEAR_LINE,
  JEST_NO_TESTS_PASS_TEXT,
  type JestFilter,
  type JestGlobalConfig,
  type JestProjectConfig,
  type JestReporterContext,
  type JestWatchHost,
  type JestWatchRunContext,
  type JestWatchRunOutcome,
  type JestWatchStdin,
  jestChangedFilesErrorText,
  jestChangedNoTestsMessage,
  jestWatchNoScmText,
  jestWatchPathIsValid,
  jestWatchRunErrorText,
  processJestResults,
  startJestWatch,
} from '@provino/dialect-jest/node'
import {
  type ChangeSource,
  createWatchSession,
  discoverProject,
  ExitCode,
  type RunGlobalHooks,
  type WatchSession,
} from '@provino/orchestrator'
import { type Environment, isCi, type TextSink } from '@provino/reporters'
import type { FileFilter, RunRequest } from '@provino/types'
import type { ProvinoChoiceOptions } from '../types.ts'
import { workerStartupEnv } from './compile-cache.ts'
import { type ExecuteOptions, executeProject } from './execute.ts'
import { setUpJestReporters } from './jest-reporters.ts'
import {
  isScmCommandFailure,
  jestSelection,
  previousDurations,
  selectProjectFiles,
} from './jest-selection.ts'
import { type DisplayOptions, outputFor, styleFor } from './reporters.ts'
import { UsageError } from './usage-error.ts'
import { latchInterrupts } from './watch-interrupt.ts'

/**
 * What watch mode reads keys from: the process's stdin by default.
 * @internal
 */
export type JestWatchInput = JestWatchStdin

/**
 * What a watch session needs from the `provino jest` command.
 * @internal
 */
export interface JestWatchCommand {
  readonly globalConfig: JestGlobalConfig
  /** The projects that run, resolved, and their Jest configs in the same order. */
  readonly projects: readonly ResolvedProject[]
  readonly configs: readonly JestProjectConfig[]
  readonly request: RunRequest
  readonly cwd: string
  readonly stdout: TextSink
  readonly stderr: NodeJS.WritableStream
  readonly env: Environment
  readonly stdin?: JestWatchInput
  /** Aborted by SIGINT or SIGTERM: the session closes (the bin ends with the signal's code). */
  readonly signal?: AbortSignal
  readonly forceSignal?: AbortSignal
  /** Where changes come from (a test's), in place of the file watcher. */
  readonly changes?: ChangeSource
  /** `--filter`, loaded; called for each project on every run, as `runJest` does. */
  readonly filter?: JestFilter
  /** The root config's own global hooks. */
  readonly globalSetup?: RunGlobalHooks
  /** The pool the command line asks for (`-w`, `--workerThreads`, `workerIdleMemoryLimit`). */
  readonly pool: ExecuteOptions['pool']
  /** How the reporters' text looks for a run with this global config. */
  readonly display: (globalConfig: JestGlobalConfig, verbose: boolean) => DisplayOptions
  /** `--tree` and `--map`: the views the `provino` reporter prints after each run. */
  readonly views: ProvinoChoiceOptions
}

/** The keys a watch session can't apply yet, each with its task: refused before anything starts. */
function refusal(globalConfig: JestGlobalConfig): string | undefined {
  const refused: string[] = []
  if (globalConfig.collectCoverage) refused.push('--coverage')
  if (globalConfig.collectTests) refused.push('--collectTests')
  if (globalConfig.detectOpenHandles) refused.push('--detectOpenHandles')
  if (refused.length === 0) return undefined
  return `${refused.join(', ')} in watch mode ${refused.length === 1 ? 'is' : 'are'} not supported yet`
}

/** jest-util's `isInteractive` (`isInteractive.ts` L10-L25): a terminal, not `dumb`, not CI. */
function isInteractive(stream: object, env: Environment): boolean {
  return Reflect.get(stream, 'isTTY') === true && env.TERM !== 'dumb' && !isCi(env)
}

function realCwd(cwd: string): string {
  try {
    return realpathSync(cwd)
  } catch {
    return cwd
  }
}

/** A run's file filters: the patterns a key set (`p`), or the paths `--runTestsByPath` named. */
function fileFiltersOf(globalConfig: JestGlobalConfig, request: RunRequest): readonly FileFilter[] {
  // As Jest: `p` sets `testPathPatterns` only (`updateGlobalConfig.ts`), and `SearchSource.ts`
  // L285-L292 goes by `nonFlagArgs` first when `runTestsByPath` is set, so the paths stay.
  if (globalConfig.runTestsByPath) return request.fileFilters
  return globalConfig.testPathPatterns.map((value): FileFilter => ({ kind: 'regex', value }))
}

/**
 * Runs `provino jest --watch` or `--watchAll` until a key ends it (`q`, Ctrl+C, Ctrl+D: 0), `--watch`
 * finds no repository (1), or a signal closes it. The session is closed and raw mode left before it
 * resolves, whatever ended it.
 * @internal
 */
export async function runJestWatch(command: JestWatchCommand): Promise<number> {
  const { globalConfig, projects, configs, request, cwd, stdout, stderr, env } = command
  const refused = refusal(globalConfig)
  if (refused !== undefined) throw new UsageError(refused)
  const [first] = projects
  if (first === undefined) throw new UsageError('the config has no project to run')
  const root = realCwd(cwd)
  // Jest's `outputStream`: stdout, or stderr under `--json` or `--useStderr`.
  const outputStream = globalConfig.json || globalConfig.useStderr ? stderr : stdout
  const interactive = isInteractive(stdout, env)
  const style = styleFor({ env, stream: stdout, ci: globalConfig.ci, colour: request.colour })
  const useCache = request.cache !== false && configs.every((config) => config.cache)
  const startupEnv = workerStartupEnv(process.env)
  const ignorePatterns = [...new Set(configs.flatMap((config) => config.watchPathIgnorePatterns))]
  const session: WatchSession = await createWatchSession(projects, {
    pool: Object.keys(startupEnv).length === 0 ? command.pool : { ...command.pool, startupEnv },
    ...(useCache ? {} : { cache: false }),
    cwd,
    // As `provino jest` without watch: a worker's own stdout goes to stderr.
    stdout: stderr,
    stderr,
    root,
    ...(command.globalSetup === undefined ? {} : { globalSetup: command.globalSetup }),
    ...(command.forceSignal === undefined ? {} : { forceSignal: command.forceSignal }),
    ...(globalConfig.runInBand ? { runInBand: true } : {}),
    isRelevant: (path) => jestWatchPathIsValid(globalConfig, path),
    ...(ignorePatterns.length === 0 ? {} : { ignorePatterns }),
    ...(command.changes === undefined ? {} : { changes: command.changes }),
  })

  // One reporter context for the session, as `runJest`'s `testSchedulerContext` is one per process.
  let current: JestWatchRunContext | undefined
  const reporterContext: JestReporterContext = {
    firstRun: true,
    previousSuccess: true,
    startRun: (next) => current?.startRun(next),
  }
  const stderrIsTerminal = Reflect.get(stderr, 'isTTY') === true
  const stdoutIsTerminal = Reflect.get(outputStream, 'isTTY') === true

  const interrupts = latchInterrupts(session)

  const runOnce = async (
    config: JestGlobalConfig,
    context: JestWatchRunContext,
  ): Promise<JestWatchRunOutcome> => {
    current = context
    // `BaseReporter.onRunStart` takes the pre-run message off the terminal (`preRunMessage.remove`).
    if (stderrIsTerminal) stderr.write(JEST_CLEAR_LINE)
    let selection: Awaited<ReturnType<typeof jestSelection>>
    try {
      selection = await jestSelection(config, projects, configs, root)
    } catch (error) {
      if (!isScmCommandFailure(error)) throw error
      // `getChangedFilesPromise.ts` L28-L37: Jest prints the error and exits 1.
      const [firstConfig] = configs
      stderr.write(
        `${jestChangedFilesErrorText(error, firstConfig ?? { rootDir: config.rootDir, testMatch: [] }, style)}\n`,
      )
      return { kind: 'exit', code: ExitCode.TestFailure }
    }
    // runJest.ts L253-L266
    if (selection.noScm && config.watch) {
      stderr.write(jestWatchNoScmText(style))
      return { kind: 'exit', code: ExitCode.TestFailure }
    }
    const filters = fileFiltersOf(config, request)
    const perProject = await Promise.all(
      projects.map(async (project) => {
        let files = await selectProjectFiles(project, await discoverProject(project), {
          selection,
          fileFilters: filters,
          cwd,
          cache: useCache,
        })
        if (command.filter !== undefined) {
          const keep = new Set(await command.filter(files.map((file) => file.path)))
          files = files.filter((file) => keep.has(file.path))
        }
        // runJest.ts L149-L161: every plugin's `shouldRunTestSuite` must say yes. With no plugin
        // on it, no file is asked (speed, D115).
        if (context.usesShouldRunTestSuite()) {
          const projectConfig = configs[projects.indexOf(project)]
          const durationOf = previousDurations(project, useCache)
          const answers = await Promise.all(
            files.map((file) =>
              context.hooks.shouldRunTestSuite({
                config: projectConfig,
                duration: durationOf(file.relativePath),
                testPath: file.path,
              }),
            ),
          )
          files = files.filter((_file, index) => answers[index] === true)
        }
        // runJest.ts L302-L308: watch mode keeps the files the last run failed.
        return config.onlyFailures ? context.failedTestsCache.filterPaths(files) : files
      }),
    )
    const keep = perProject.map((files) => new Set(files.map((file) => file.path)))
    if (perProject.every((files) => files.length === 0)) {
      // runJest.ts L369-L381 (watch mode always passes with no tests), through `CustomConsole`,
      // which clears the line first.
      const changed = jestChangedNoTestsMessage(config, { interactive, style })
      if (stdoutIsTerminal) outputStream.write(JEST_CLEAR_LINE)
      await outputStream.write(`${changed?.message ?? style.bold(JEST_NO_TESTS_PASS_TEXT)}\n`)
    }
    const results = createJestResults({ globalConfig: config, projectConfigs: configs })
    const setup = await setUpJestReporters({
      globalConfig: config,
      configs,
      filesPerProject: async () => perProject.map((files) => files.length),
      results,
      output: outputFor({ env, stderr, ci: config.ci, colour: request.colour }),
      env,
      context: reporterContext,
      views: command.views,
    })
    const [project, ...others] = projects
    if (project === undefined) throw new UsageError('the config has no project to run')
    await executeProject({
      project,
      // Jest's `success` (TestScheduler.ts L338-L352, L486-L491) is settled after the reporters
      // have heard the end of the run: `!(anyTestFailures || snapshot.failure || anyReporterErrors)`.
      // The collector hands its reporters `false` until then, so a run left unsettled writes
      // `success: false` to `--json` however it went. `executeProject` makes this call as the
      // reporters finish, before `processJestResults` below (a global setup that failed ends
      // earlier, and a watch run has none).
      onReporterFailures: (failures) => results.reportersFailed(failures.length > 0),
      others,
      cwd,
      stdout,
      stderr,
      reporters: setup.reporters,
      text: setup.text,
      views: command.views,
      announceReporterFailures: setup.announceThrown ? 'thrown' : false,
      leadingReporters: [results.reporter],
      env,
      display: command.display(config, setup.verbose),
      pool: command.pool,
      testNamePattern: config.testNamePattern,
      update: config.updateSnapshot === 'all',
      fileFilter: async (own, files) => {
        const kept = keep[projects.indexOf(own)]
        return kept === undefined ? [] : files.filter((file) => kept.has(file.path))
      },
      passWithNoTests: true,
      ...(config.bail > 0 ? { bail: { count: config.bail } } : {}),
      detectLeaks: (resolved) => configs[projects.indexOf(resolved)]?.detectLeaks === true,
      ...(config.logHeapUsage ? { logHeapUsage: true } : {}),
      session: interrupts.session,
    })
    // `processResults` (runJest.ts L173-L213) after every run: `--json` and `testResultsProcessor`.
    if (config.json || config.testResultsProcessor !== undefined) {
      await processJestResults({
        aggregated: results.aggregated(),
        globalConfig: config,
        cwd,
        stdout,
        outputStream,
      })
    }
    return { kind: 'complete', results: results.aggregated() }
  }

  const run = async (
    config: JestGlobalConfig,
    context: JestWatchRunContext,
  ): Promise<JestWatchRunOutcome> => {
    interrupts.begin()
    try {
      return await runOnce(config, context)
    } finally {
      interrupts.end()
    }
  }

  const stdin: JestWatchInput = command.stdin ?? process.stdin
  const host: JestWatchHost = {
    stdin,
    stdout: outputStream,
    stderr,
    interactive,
    style,
    appleTerminal: env.TERM_PROGRAM === 'Apple_Terminal',
    run,
    interrupt: interrupts.interrupt,
    onFileChange: (listener) => session.onChange(() => listener()),
    formatError: (error) =>
      jestWatchRunErrorText(error, configs[0] ?? { rootDir: globalConfig.rootDir, testMatch: [] }),
    // watch.ts L231-L245: each project's test files with no pattern, for `onFileChange`.
    listTests: async () => ({
      projects: await Promise.all(
        projects.map(async (project, index) => ({
          config: configs[index],
          testPaths: (await discoverProject(project)).map((file) => file.path),
        })),
      ),
    }),
    cwd,
  }

  let watch: ReturnType<typeof startJestWatch> | undefined
  let onAbort: (() => void) | undefined
  try {
    watch = startJestWatch(globalConfig, host)
    const { signal } = command
    const aborted = new Promise<number>((resolve) => {
      onAbort = () => resolve(ExitCode.Pass)
      if (signal?.aborted === true) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
    })
    return await Promise.race([watch.done, aborted])
  } finally {
    // Each step has its own try: raw mode is left and the listeners are off whatever one of them
    // throws, and the session is closed last, always.
    try {
      if (onAbort !== undefined) command.signal?.removeEventListener('abort', onAbort)
    } finally {
      try {
        watch?.dispose()
      } finally {
        try {
          if (typeof stdin.setRawMode === 'function' && Reflect.get(stdin, 'isRaw') === true) {
            stdin.setRawMode(false)
          }
        } finally {
          await session.close()
        }
      }
    }
  }
}
