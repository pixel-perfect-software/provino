// A watch fixture's recording (B23c Phase 3): Jest `--watch`/`--watchAll` on a terminal from the
// pty relay (or on a pipe for `tty: false`), driven by the fixture's steps, kept as its runs (the
// run-log reporter's lines), its transcript, its exit code and the files it left. Both process
// groups are killed in `finally`, whatever the steps did.
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { JsonValue } from '@provino/types'
import { HarnessError } from '../errors.ts'
import type { FixtureWatch } from '../fixture.ts'
import type { GoldenObserved } from '../golden.ts'
import { type PtyProcess, spawnPiped, spawnPty } from '../pty.ts'
import { WATCH_DONE_ENV } from '../reporters/jest-watch-done.ts'
import { WATCH_LOG_ENV } from '../reporters/jest-watch-log.ts'
import { isNotFound } from './guards.ts'
import { runScmStep, type ScmRepo } from './scm.ts'
import { runWatchSteps, type WatchHost } from './watch-steps.ts'
import { maskTimes, renderTranscript } from './watch-transcript.ts'

/** The run-log reporter, by absolute path, as Jest's `reporters` names it. */
export const WATCH_LOG_REPORTER_PATH: string = fileURLToPath(
  new URL('../reporters/jest-watch-log.ts', import.meta.url),
)

/** The recorder's watch plugin (`onTestRunComplete`), by absolute path, as `watchPlugins` names it. */
export const WATCH_DONE_PLUGIN_PATH: string = fileURLToPath(
  new URL('../reporters/jest-watch-done.ts', import.meta.url),
)

/** Where the recorder's own files are (`.harness-out/`) and Jest's cache: changes Jest never reruns for. */
const IGNORED_BY_WATCH: readonly string[] = ['<rootDir>/.harness-out/', '<rootDir>/.jest-cache/']

/**
 * The Jest config of a watch fixture: the recorder's, with the default reporter and the run log
 * beside it, the done plugin after the fixture's own `watchPlugins`, and the recorder's own
 * directories out of the watcher's reach (added to any `watchPathIgnorePatterns` the fixture's
 * overlay gives).
 */
export function watchJestConfig(
  base: Readonly<Record<string, unknown>>,
  logs: { readonly runLog: string; readonly doneLog: string },
): Record<string, unknown> {
  const ignored = base.watchPathIgnorePatterns
  const plugins = base.watchPlugins
  return {
    ...base,
    reporters: ['default', [WATCH_LOG_REPORTER_PATH, { outputFile: logs.runLog }]],
    watchPlugins: [
      ...(Array.isArray(plugins) ? plugins : []),
      [WATCH_DONE_PLUGIN_PATH, { outputFile: logs.doneLog }],
    ],
    watchPathIgnorePatterns: [...(Array.isArray(ignored) ? ignored : []), ...IGNORED_BY_WATCH],
  }
}

/** Variables a terminal program sets that change what Jest or its libraries draw. */
const TERMINAL_NOISE: readonly string[] = ['TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'COLORTERM']

/**
 * A watch session's environment: the recorder's (`runnerEnv`), but not a CI run, so jest-util's
 * `isInteractive` is true on a terminal (`ci-info` skips every other check when `CI` is
 * `"false"`), with a terminal type that is not `dumb`. `NO_COLOR=1` stays; `FORCE_COLOR=0` is
 * added because chalk 4 (Jest's) reads `FORCE_COLOR` and not `NO_COLOR`.
 */
export function watchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, CI: 'false', TERM: 'xterm-256color', FORCE_COLOR: '0' }
  for (const name of TERMINAL_NOISE) delete out[name]
  return out
}

/** The run log's entries: one JSON value per non-empty line. */
export function parseRunLog(text: string, source: string): JsonValue[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line) as JsonValue
      } catch (cause) {
        throw new HarnessError(
          'HARNESS_WATCH_FAILED',
          `${source}: line ${index + 1} of the run log is not JSON`,
          { cause },
        )
      }
    })
}

async function readIfThere(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (cause) {
    if (isNotFound(cause)) return null
    throw cause
  }
}

const POLL_MS = 25

function lineCount(text: string): number {
  return text.split('\n').filter((line) => line !== '').length
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** What a watch recording needs from the recorder. */
export interface WatchRecordOptions {
  readonly watch: FixtureWatch
  /** `node`, its flags and Jest's bin, the config, then the fixture's `watch.argv`. */
  readonly argv: readonly string[]
  readonly workDir: string
  readonly env: NodeJS.ProcessEnv
  /** The run log the reporter appends to (started empty here). */
  readonly runLog: string
  /** The file the done plugin appends to at the end of each run (started empty here). */
  readonly doneLog: string
  /** The fixture's repository, for `scm` steps; `write` and `remove` need none. */
  readonly repo: ScmRepo
  /** The recorder's text normalization (the work directory as `<root>`, durations). */
  readonly normalize: (text: string) => string
  /** The work directory's spellings, which the run log's strings have as `<root>`. */
  readonly roots: readonly string[]
  /** The whole session's deadline, in milliseconds. */
  readonly timeoutMs: number
  /** Names the fixture in errors. */
  readonly source: string
  /** The terminal: `spawnPty` (or `spawnPiped` for `tty: false`) unless a test passes its own. */
  readonly spawn?: (
    argv: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    deadline: AbortSignal,
  ) => Promise<PtyProcess>
  /** The pause between two reads of the run log and the done file (default 25 ms). */
  readonly poll?: () => Promise<void>
}

function defaultSpawn(tty: boolean) {
  return (
    argv: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    deadline: AbortSignal,
  ): Promise<PtyProcess> =>
    tty ? spawnPty(argv, { cwd, env, deadline }) : spawnPiped(argv, { cwd, env, deadline })
}

/**
 * Records one watch session. The steps run against the live session; then, whatever happened,
 * the child's and the relay's process groups are killed and probed until empty. Every run the log
 * holds must be one a `waitRun` waited for, else the session did something the steps didn't
 * pin down and the recording is refused (`HARNESS_WATCH_FAILED`).
 */
export async function recordWatchSession(options: WatchRecordOptions): Promise<GoldenObserved> {
  const { watch, source } = options
  await writeFile(options.runLog, '')
  await writeFile(options.doneLog, '')
  const env = {
    ...watchEnv(options.env),
    [WATCH_LOG_ENV]: options.runLog,
    [WATCH_DONE_ENV]: options.doneLog,
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  const spawn = options.spawn ?? defaultSpawn(watch.tty)
  const poll = options.poll ?? (() => sleep(POLL_MS))
  let session: PtyProcess | undefined
  let runs: number
  let exitCode: number | null | undefined
  try {
    session = await spawn(options.argv, options.workDir, env, controller.signal)
    let ended = false
    void session.exit.then(
      () => {
        ended = true
      },
      () => {
        ended = true
      },
    )
    const host: WatchHost = {
      session,
      async waitRuns(count) {
        for (;;) {
          // The log grows when the reporters finish, the done file once Jest reads keys again.
          const seen = parseRunLog((await readIfThere(options.runLog)) ?? '', source).length
          const done = lineCount((await readIfThere(options.doneLog)) ?? '')
          if (seen > count || done > count) {
            throw new HarnessError(
              'HARNESS_WATCH_FAILED',
              `${source}: the run log holds ${seen} runs (${done} done) where a step waits for ${count}: a run no step waited for`,
            )
          }
          if (seen === count && done === count) return
          if (ended || controller.signal.aborted) {
            throw new HarnessError(
              'HARNESS_WATCH_FAILED',
              `${source}: ${ended ? 'the session ended' : 'the deadline passed'} with ${seen} of ${count} runs. Output tail:\n${session?.output().slice(-2000) ?? ''}`,
            )
          }
          await poll()
        }
      },
      change: (step) => runScmStep(options.repo, step),
    }
    const result = await runWatchSteps(watch.steps, host)
    runs = result.runs
    exitCode = result.exit?.exitCode
  } finally {
    clearTimeout(timer)
    await session?.kill()
  }

  const entries = parseRunLog((await readIfThere(options.runLog)) ?? '', source)
  if (entries.length !== runs) {
    throw new HarnessError(
      'HARNESS_WATCH_FAILED',
      `${source}: the run log holds ${entries.length} runs, but the steps waited for ${runs}: a run no step waited for`,
    )
  }
  const mask = (text: string): string =>
    (watch.mask ?? []).reduce(
      (out, pattern) => out.replace(new RegExp(pattern, 'gm'), '<masked>'),
      text,
    )
  const rooted = (text: string): string =>
    options.roots.reduce((out, root) => out.replaceAll(root, '<root>'), text)
  const captured = (name: string): boolean => watch.capture.includes(name)
  const files = watch.capture.filter((entry) => entry.startsWith('file:'))

  let transcript: string | undefined
  if (captured('transcript')) {
    let lines = mask(maskTimes(options.normalize(renderTranscript(session.output())))).split('\n')
    if (watch.keepLines !== undefined) {
      const keep = new RegExp(watch.keepLines)
      lines = lines.filter((line) => keep.test(line))
      if (lines.length === 0) {
        throw new HarnessError(
          'HARNESS_FIXTURE_BAD_WATCH',
          `${source}: "watch" "keepLines" kept no line of the transcript`,
          { path: source },
        )
      }
    }
    transcript = lines.join('\n')
  }
  return {
    ...(captured('exitCode') ? { exitCode: exitCode ?? null } : {}),
    ...(files.length === 0
      ? {}
      : {
          files: Object.fromEntries(
            await Promise.all(
              files.map(async (entry) => {
                const file = entry.slice('file:'.length)
                const text = await readIfThere(path.join(options.workDir, file))
                return [file, text === null ? null : mask(options.normalize(text))] as const
              }),
            ),
          ),
        }),
    ...(captured('runs')
      ? { runs: entries.map((entry) => JSON.parse(rooted(JSON.stringify(entry))) as JsonValue) }
      : {}),
    ...(transcript === undefined ? {} : { transcript }),
  }
}
