// `provino run --watch` and `--watchAll` (B27k, D202): the orchestrator's watch session (one warm
// pool, the affected index) driven by four keys, with none of Jest's watch plugins or typeahead.
// `provino jest --watch` is `jest-watch.ts`. This one is for a project run from a `provino.config.*`:
// the first run is every file; a change reruns the files that reach it through the affected index
// (which selects every file for a change to one of the project's inputs: a setup file, the
// environment, the root `package.json`, a lockfile, the tsconfig), and `--watchAll` reruns every file
// on any change. A change to the config file itself loads it again: a new session, the same keys.
// On a terminal `a` runs all, `f` the failed, Enter the last again, `q` quits (Ctrl+C and Ctrl+D
// too), Ctrl+Z suspends, and a one-line hint follows each run; off a terminal there are no keys and
// no hint. Reporters are built for each run by `executeProject`, which tells them it is a watch run
// (`ReporterContext.watch`, D142: a run that names none never gets `provino`), so the live footer
// is erased at each run's end and the terminal is put back whatever ends the loop.
import { basename, join, resolve } from 'node:path'
import {
  type ChangeSource,
  type CoalesceClock,
  createWatchSession,
  ExitCode,
  OrchestratorError,
  type WatchSession,
} from '@provino/orchestrator'
import { detectOutput, isCi } from '@provino/reporters'
import type { AffectedSelection } from '@provino/types'
import type { RunOptions } from '../types.ts'
import { workerStartupEnv } from './compile-cache.ts'
import { type ExecuteOptions, executeProject } from './execute.ts'
import { DOCUMENT_REPORTERS, isDocumentReporter } from './reporter-names.ts'
import {
  executeOptionsOf,
  patternFilters,
  type ResolvedRun,
  reportNoMatch,
  reportRunError,
  resolveRun,
  selectByPatterns,
} from './run-setup.ts'
import { latchInterrupts, type RunInterrupts } from './watch-interrupt.ts'
import { createWatchQueue, type Trigger } from './watch-queue.ts'

/**
 * What watch mode reads keys from: the process's stdin by default.
 * @internal
 */
export interface WatchInput {
  readonly isTTY?: boolean
  readonly isRaw?: boolean
  setRawMode?(mode: boolean): unknown
  resume(): unknown
  pause(): unknown
  on(event: 'data', listener: (chunk: { toString(): string }) => void): unknown
  on(event: 'end' | 'error', listener: () => void): unknown
  off(event: 'data', listener: (chunk: { toString(): string }) => void): unknown
  off(event: 'end' | 'error', listener: () => void): unknown
}

/**
 * The seams a test uses: its own keys, its own changes, its own coalescing clock and its own way
 * to suspend the process.
 * @internal
 */
export interface NativeWatchIo {
  readonly stdin?: WatchInput
  readonly changes?: ChangeSource
  readonly clock?: CoalesceClock
  /** What Ctrl+Z does after the terminal is put back. Default: raise `SIGTSTP` on this process. */
  readonly suspend?: () => void
}

/** `--watch`: the files a change reaches; `--watchAll`: every file on any change. */
export type WatchMode = 'changed' | 'all'

/** Said once when a config asks for coverage under watch, which collects none. */
export const COVERAGE_NOTICE = 'Provino: coverage is not collected in watch mode\n'

/** The line after each run on a terminal. */
export const WATCH_HINT = 'Watching: a runs all, f runs the failed, Enter reruns, q quits'

/**
 * The paths a run's own reporters write (a json, junit or html document): a change to one must not
 * start another run. `outputFile` is against `cwd`, a default file against each root.
 * @internal
 */
export function outputFilesOf(
  reporters: RunOptions['reporters'],
  cwd: string,
  roots: readonly (string | undefined)[],
): ReadonlySet<string> {
  const files = new Set<string>()
  for (const choice of reporters ?? []) {
    const name = typeof choice === 'string' ? choice : Array.isArray(choice) ? choice[0] : undefined
    if (typeof name !== 'string' || !isDocumentReporter(name)) continue
    const given: unknown = Array.isArray(choice) ? choice[1] : undefined
    const outputFile: unknown =
      typeof given === 'object' && given !== null ? Reflect.get(given, 'outputFile') : undefined
    if (typeof outputFile === 'string') {
      files.add(resolve(cwd, outputFile))
      continue
    }
    const byDefault = DOCUMENT_REPORTERS[name]
    if (byDefault === null) continue
    for (const root of roots) if (root !== undefined) files.add(resolve(root, byDefault))
  }
  return files
}

/** One session over one resolved config, until the config changes. */
interface Round {
  readonly resolved: ResolvedRun
  readonly session: WatchSession
  readonly interrupts: RunInterrupts
  close(): Promise<void>
}

async function watchLoop(
  options: RunOptions,
  mode: WatchMode,
  io: NativeWatchIo,
  first: ResolvedRun,
): Promise<number> {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const stdin: WatchInput = io.stdin ?? process.stdin
  const { env } = first
  // A watch run collects no coverage: a config that asks for it gets one line saying so.
  if (first.coverage.enabled) stderr.write(COVERAGE_NOTICE)
  // Every run, a related one included, stays inside the command line's patterns.
  const filters = patternFilters(options.testPathPatterns)
  // Reruns force `passWithNoTests`, so a pattern that selects nothing is said once: after the first
  // run, and only when it ran no file.
  let sayNoMatch = true
  const stderrIsTerminal = Reflect.get(stderr, 'isTTY') === true
  const columns: unknown = Reflect.get(stderr, 'columns')
  // The reporters' own rule for a live terminal (not CI, not dumb, not an agent's), and a
  // terminal to read keys from.
  const interactive =
    stdin.isTTY === true &&
    detectOutput({
      env,
      ci: options.ci ?? isCi(env),
      stream: { isTTY: stderrIsTerminal, ...(typeof columns === 'number' ? { columns } : {}) },
    }).live

  const queue = createWatchQueue()
  let quitting = options.signal?.aborted === true
  let reload = false
  let lastExit = 0
  let wake: (() => void) | undefined
  let current: Round | undefined
  const poke = (): void => {
    const waiting = wake
    wake = undefined
    waiting?.()
  }
  const quit = (): void => {
    if (quitting) return
    quitting = true
    current?.interrupts.interrupt()
    poke()
  }

  const open = async (resolved: ResolvedRun): Promise<Round> => {
    const { project, others, root, cwd, pool } = resolved
    const projects = [project, ...others]
    const outputs = outputFilesOf(options.reporters, cwd, [project.rootDir, root])
    const startupEnv = workerStartupEnv(process.env)
    const session = await createWatchSession(projects, {
      pool: Object.keys(startupEnv).length === 0 ? pool : { ...pool, startupEnv },
      ...(options.cache === false ? { cache: false as const } : {}),
      cwd,
      // As a run without watch: a worker's own stdout goes to stderr.
      stdout: stderr,
      stderr,
      ...(root === undefined ? {} : { root }),
      ...(options.forceSignal === undefined ? {} : { forceSignal: options.forceSignal }),
      configFile: resolved.configPath,
      // A run's own writes (snapshots, a reporter's document) must not start another run.
      isRelevant: (path) => !path.endsWith('.snap') && !outputs.has(path),
      ...(io.changes === undefined ? {} : { changes: io.changes }),
      ...(io.clock === undefined ? {} : { clock: io.clock }),
    })
    const unsubscribe = session.onChange((batch) => {
      queue.forget(batch.filter((event) => event.kind === 'unlink').map((event) => event.path))
      if (batch.some((event) => event.path === resolved.configPath)) reload = true
      else if (mode === 'all') queue.all()
      else queue.changed(batch.map((event) => event.path))
      poke()
    })
    return {
      resolved,
      session,
      interrupts: latchInterrupts(session),
      close: async () => {
        unsubscribe()
        await session.close()
      },
    }
  }

  // The keys. Raw mode is put back as it was found, and nothing here is set up before the session
  // exists, so a throw below closes it.
  const wasRaw = stdin.isRaw === true
  let rawOn = false
  const enterRaw = (): void => {
    stdin.setRawMode?.(true)
    rawOn = true
  }
  const leaveRaw = (): void => {
    if (!rawOn) return
    rawOn = false
    stdin.setRawMode?.(wasRaw)
  }
  const resume = (): void => {
    if (!quitting) enterRaw()
  }
  const onData = (chunk: { toString(): string }): void => {
    // One key at a time: a paste, an escape sequence (Alt+q, arrows) is not a key of ours.
    const key = chunk.toString()
    if (key.length !== 1) return
    if (key === 'a') queue.all()
    else if (key === 'f') queue.failed()
    else if (key === '\r' || key === '\n') queue.rerun()
    else if (key === 'q' || key === '\x03' || key === '\x04') quit()
    else if (key === '\x1a') {
      leaveRaw()
      process.once('SIGCONT', resume)
      ;(io.suspend ?? (() => process.kill(process.pid, 'SIGTSTP')))()
      return
    } else return
    poke()
  }

  const runOnce = async (round: Round, trigger: Trigger): Promise<void> => {
    const { resolved, interrupts } = round
    let extra: Partial<ExecuteOptions> = {}
    if (trigger.kind === 'failed') {
      if (queue.failedFiles.size === 0) {
        stderr.write('No failed test files to run.\n')
        return
      }
      extra = { onlyFailures: new Set(queue.failedFiles) }
    } else if (trigger.kind === 'changed') {
      const selection: AffectedSelection = { kind: 'related', paths: trigger.paths }
      // A selection replaces the file filters, so the command line's patterns restrict the files it
      // reached here.
      extra =
        filters.length === 0
          ? { selection }
          : {
              selection,
              fileFilter: (project, files) =>
                selectByPatterns(files, filters, project, resolved.cwd),
            }
    }
    interrupts.begin()
    let result: Awaited<ReturnType<typeof executeProject>>
    try {
      result = await executeProject({
        ...executeOptionsOf(options, resolved, stdout, stderr),
        // A change that reaches no test is not a failed run; a run of all follows the option and the policy.
        ...(trigger.kind === 'all' ? {} : { passWithNoTests: true }),
        session: interrupts.session,
        ...extra,
      })
    } catch (error) {
      // A run cut short by the session closing under it has nothing to say.
      if (quitting) return
      // A new file that two projects both select fails this run, not the session.
      if (error instanceof OrchestratorError && error.code === 'ORCH_OVERLAPPING_PROJECTS') {
        stderr.write(`Provino: ${error.message}\n`)
        lastExit = ExitCode.UsageError
        return
      }
      throw error
    } finally {
      interrupts.end()
    }
    if (quitting) return
    lastExit = result.exitCode
    if (sayNoMatch) {
      sayNoMatch = false
      if (result.summary?.files.length === 0) await reportNoMatch(options, resolved, stderr)
    }
    if (result.summary !== null) {
      const projects = [resolved.project, ...resolved.others]
      queue.record(
        trigger,
        result.summary.files.map((file) => ({
          path: join(
            projects[file.file.projectIndex ?? 0]?.rootDir ?? resolved.cwd,
            file.file.path,
          ),
          state: file.state,
        })),
      )
    }
  }

  /** A changed config: resolve it again, and swap the session only if it resolves. */
  const reloadConfig = async (): Promise<void> => {
    reload = false
    const old = current
    if (old === undefined) return
    stderr.write(`Provino: ${basename(old.resolved.configPath)} changed, loading it again\n`)
    let next: Round
    try {
      next = await open(await resolveRun(options))
    } catch (error) {
      if (reportRunError(error, stderr) === undefined) throw error
      stderr.write('Provino: keeping the previous config until it changes again\n')
      return
    }
    current = next
    await old.close()
    queue.all()
  }

  current = await open(first)
  try {
    if (interactive) {
      enterRaw()
      stdin.resume()
      stdin.on('data', onData)
      stdin.on('end', quit)
      stdin.on('error', quit)
    }
    options.signal?.addEventListener('abort', quit, { once: true })
    while (!quitting) {
      if (reload) {
        await reloadConfig()
        continue
      }
      const trigger = queue.take()
      if (trigger === undefined) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        continue
      }
      await runOnce(current, trigger)
      if (interactive && !quitting) stderr.write(`${WATCH_HINT}\n`)
    }
    return lastExit
  } finally {
    // Each step has its own try: the keys are off and raw mode is back whatever one of them
    // throws, and the session is closed last, always.
    try {
      options.signal?.removeEventListener('abort', quit)
      process.off('SIGCONT', resume)
      if (interactive) {
        stdin.off('data', onData)
        stdin.off('end', quit)
        stdin.off('error', quit)
      }
    } finally {
      try {
        leaveRaw()
        if (interactive) stdin.pause()
      } finally {
        await current.close()
      }
    }
  }
}

/**
 * Runs `provino run --watch` or `--watchAll` until `q`, Ctrl+C or Ctrl+D, or a signal closes it,
 * and resolves with the exit code of the last run that finished (the bin ends with a signal's own
 * code). Bad input is reported as `run()` reports it.
 * @internal
 */
export async function runNativeWatch(
  options: RunOptions,
  mode: WatchMode,
  io: NativeWatchIo = {},
): Promise<number> {
  const stderr = options.stderr ?? process.stderr
  try {
    const first = await resolveRun(options)
    // A signal that came during the load: nothing to watch.
    if (options.signal?.aborted === true) return 0
    return await watchLoop(options, mode, io, first)
  } catch (error) {
    const code = reportRunError(error, stderr)
    if (code === undefined) throw error
    return code
  }
}
