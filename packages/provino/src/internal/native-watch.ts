// `provino run --watch` and `--watchAll` (B27k, D202): the orchestrator's watch session (one warm
// pool, the affected index) driven by four keys, with none of Jest's watch plugins or typeahead.
// `provino jest --watch` is `jest-watch.ts`. This one is for a project run from a `provino.config.*`:
// the first run is every file; a change reruns the files that reach it through the affected index
// (every file when the change is one nothing can map: a manifest, a config or a tsconfig, or
// `--watchAll`). On a terminal `a` runs all, `f` the failed, Enter the last again, `q` quits (Ctrl+C
// and Ctrl+D too), and a one-line hint follows each run; off a terminal there are no keys and no
// hint. Reporters are built for each run by `executeProject`, which tells them it is a watch run
// (`ReporterContext.watch`, D142: a run that names none never gets `provino`), so the live footer
// is erased at each run's end and the terminal is put back whatever ends the loop.
import { basename, join } from 'node:path'
import type { CoalesceClock } from '@provino/orchestrator'
import { type ChangeSource, createWatchSession, ExitCode } from '@provino/orchestrator'
import { isCi } from '@provino/reporters'
import type { AffectedSelection } from '@provino/types'
import { reportRunError, resolveRun } from '../run.ts'
import type { RunOptions } from '../types.ts'
import { workerStartupEnv } from './compile-cache.ts'
import { type ExecuteOptions, executeProject } from './execute.ts'
import { UsageError } from './usage-error.ts'
import { latchInterrupts } from './watch-interrupt.ts'

/**
 * What watch mode reads keys from: the process's stdin by default.
 * @internal
 */
export interface WatchInput {
  readonly isTTY?: boolean
  readonly isRaw?: boolean
  setRawMode?(mode: boolean): unknown
  setEncoding(encoding: 'utf8'): unknown
  resume(): unknown
  pause(): unknown
  on(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown
  off(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown
}

/**
 * The seams a test uses: its own keys, its own changes and its own coalescing clock.
 * @internal
 */
export interface NativeWatchIo {
  readonly stdin?: WatchInput
  readonly changes?: ChangeSource
  readonly clock?: CoalesceClock
}

/** `--watch`: the files a change reaches; `--watchAll`: every file on any change. */
export type WatchMode = 'changed' | 'all'

/** The line after each run on a terminal. */
export const WATCH_HINT = 'Watching: a runs all, f runs the failed, Enter reruns, q quits'

/** Changes nothing maps to a test file: they rerun everything. */
const UNMAPPABLE = /^(?:package\.json|provino\.config\.[cm]?[jt]s|tsconfig[^/]*\.json)$/

type Trigger =
  | { readonly kind: 'all' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'changed'; readonly paths: readonly string[] }

function isInteractive(
  stdin: WatchInput,
  stderr: object,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    stdin.isTTY === true &&
    Reflect.get(stderr, 'isTTY') === true &&
    env.TERM !== 'dumb' &&
    !isCi(env)
  )
}

async function watchLoop(options: RunOptions, mode: WatchMode, io: NativeWatchIo): Promise<number> {
  const { project, others, root, cwd, env, pool } = await resolveRun(options)
  const projects = [project, ...others]
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const stdin: WatchInput = io.stdin ?? process.stdin
  const interactive = isInteractive(stdin, stderr, env)
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
    // A run's own snapshot writes must not start another run.
    isRelevant: (path) => !path.endsWith('.snap'),
    ...(io.changes === undefined ? {} : { changes: io.changes }),
    ...(io.clock === undefined ? {} : { clock: io.clock }),
  })
  const interrupts = latchInterrupts(session)

  let failed = new Set<string>()
  let last: Trigger = { kind: 'all' }
  let wantAll = true
  let wantFailed = false
  let wantRerun = false
  const changed = new Set<string>()
  let quitting = false
  let wake: (() => void) | undefined
  const poke = (): void => {
    const waiting = wake
    wake = undefined
    waiting?.()
  }
  const quit = (): void => {
    if (quitting) return
    quitting = true
    interrupts.interrupt()
    poke()
  }

  const unsubscribe = session.onChange((batch) => {
    if (mode === 'all' || batch.some((event) => UNMAPPABLE.test(basename(event.path)))) {
      wantAll = true
    } else {
      for (const event of batch) changed.add(event.path)
    }
    poke()
  })
  const onData = (chunk: string | Uint8Array): void => {
    for (const key of typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')) {
      if (key === 'a') wantAll = true
      else if (key === 'f') wantFailed = true
      else if (key === '\r' || key === '\n') wantRerun = true
      else if (key === 'q' || key === '\x03' || key === '\x04') quit()
      else continue
      poke()
    }
  }
  const onAbort = (): void => quit()
  if (options.signal?.aborted === true) quitting = true
  else options.signal?.addEventListener('abort', onAbort, { once: true })
  if (interactive) {
    stdin.setRawMode?.(true)
    stdin.setEncoding('utf8')
    stdin.resume()
    stdin.on('data', onData)
  }

  /** The next thing to run, taking what it covers off the queue. */
  const take = (): Trigger | undefined => {
    if (wantAll) {
      wantAll = false
      wantFailed = false
      changed.clear()
      return { kind: 'all' }
    }
    if (wantFailed) {
      wantFailed = false
      return { kind: 'failed' }
    }
    if (changed.size > 0) {
      const paths = [...changed].sort()
      changed.clear()
      return { kind: 'changed', paths }
    }
    if (wantRerun) {
      wantRerun = false
      return last
    }
    return undefined
  }

  const runOnce = async (trigger: Trigger): Promise<void> => {
    let extra: Partial<ExecuteOptions> = {}
    if (trigger.kind === 'failed') {
      if (failed.size === 0) {
        stderr.write('No failed test files to run.\n')
        return
      }
      extra = { onlyFailures: new Set(failed) }
    } else if (trigger.kind === 'changed') {
      const selection: AffectedSelection = { kind: 'related', paths: trigger.paths }
      extra = { selection }
    }
    last = trigger
    interrupts.begin()
    let result: Awaited<ReturnType<typeof executeProject>>
    try {
      result = await executeProject({
        project,
        ...(others.length === 0 ? {} : { others }),
        ...(root === undefined ? {} : { root }),
        cwd,
        stdout,
        stderr,
        reporters: options.reporters,
        env,
        ...(options.emoji === false ? { display: { emoji: false } } : {}),
        ...(options.views === undefined ? {} : { views: options.views }),
        pool,
        testNamePattern: options.testNamePattern,
        update: options.updateSnapshot,
        passWithNoTests: true,
        ...(options.bail === undefined || options.bail === 0
          ? {}
          : { bail: { count: options.bail } }),
        session: interrupts.session,
        ...extra,
      })
    } catch (error) {
      // A run cut short by the session closing under it has nothing to say.
      if (quitting) return
      throw error
    } finally {
      interrupts.end()
    }
    if (result.summary !== null) {
      // The failed files: what failed before, minus the files that ran now, plus the ones that failed now.
      const next = trigger.kind === 'all' ? new Set<string>() : new Set(failed)
      for (const file of result.summary.files) {
        const base = projects[file.file.projectIndex ?? 0]?.rootDir ?? cwd
        const path = join(base, file.file.path)
        if (file.state === 'fail') next.add(path)
        else next.delete(path)
      }
      failed = next
    }
  }

  try {
    while (!quitting) {
      const trigger = take()
      if (trigger === undefined) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        continue
      }
      await runOnce(trigger)
      if (interactive && !quitting) stderr.write(`${WATCH_HINT}\n`)
    }
    return ExitCode.Pass
  } finally {
    // Each step has its own try: the keys are off and raw mode is left whatever one of them
    // throws, and the session is closed last, always.
    try {
      options.signal?.removeEventListener('abort', onAbort)
      unsubscribe()
      if (interactive) stdin.off('data', onData)
    } finally {
      try {
        if (interactive) {
          if (stdin.isRaw === true) stdin.setRawMode?.(false)
          stdin.pause()
        }
      } finally {
        await session.close()
      }
    }
  }
}

/**
 * Runs `provino run --watch` or `--watchAll` until `q`, Ctrl+C or Ctrl+D (0), or a signal closes it
 * (the bin ends with the signal's code). Bad input is reported as `run()` reports it.
 * @internal
 */
export async function runNativeWatch(
  options: RunOptions,
  mode: WatchMode,
  io: NativeWatchIo = {},
): Promise<number> {
  const stderr = options.stderr ?? process.stderr
  try {
    if (options.detectOpenHandles === true) {
      throw new UsageError('--detectOpenHandles in watch mode is not supported')
    }
    if (options.shard !== undefined) {
      throw new UsageError('--shard in watch mode is not supported')
    }
    return await watchLoop(options, mode, io)
  } catch (error) {
    const code = reportRunError(error, stderr)
    if (code === undefined) throw error
    return code
  }
}
