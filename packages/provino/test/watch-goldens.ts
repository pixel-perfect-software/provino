// The machinery the `watch/*` goldens of Jest 30.5.2 are played with (B23c Phases 8 and 9), shared
// by `jest-watch.test.ts` and `jest-watch-plugins.test.ts`. Each fixture is written as the recorder
// writes it (its config in `.harness-out/`, with the run-log reporter beside `default` and the
// recorder's directories out of the watcher's reach), its `scm` steps run with the harness's
// hermetic git, and its steps are played by the harness's own `runWatchSteps`. The run log, the
// kept transcript lines (the terminal rendered by the harness's model, times masked) and the exit
// code must be Jest's.
//
// Two ways to drive it:
// - **On a terminal** (the bin under the harness's pty relay, a real file watcher): Jest's own
//   setting. A sandbox that denies `/dev/ptmx` or `fs.watch` skips these, saying why; with `CI`
//   set they refuse to skip (CI's Linux legs run them).
// - **In this process** (`runJestCommand` on a fake terminal: one stream for stdout and stderr with
//   `isTTY`, a stdin with raw mode, and the changes fed to the session as the steps make them):
//   the same steps and the same comparison, with no terminal and no watcher, so it runs anywhere.
//
// The recorder's done plugin (a watch plugin of the recorder's own) is replaced by what it stands
// for: a run is over once the run log holds it and the driver has written what it writes after a
// run (the usage line), since the last key or change.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { isCi } from '@provino/reporters'
import { commitAll, git, gitEnv, initRepo } from './hermetic-git.ts'
import type { Json } from './mask.ts'
import { normalizedJson } from './mask.ts'
import { type Materialized, materialize, type RecordedFixture } from './recorded.ts'
import { replayEnv } from './recorded-run.ts'
import { CLI, outputFree } from './support.ts'

const HARNESS = new URL('../../harness/src/', import.meta.url)
/** The run-log reporter the recorder's config names (`watchJestConfig`). */
const WATCH_LOG_REPORTER = fileURLToPath(new URL('reporters/jest-watch-log.ts', HARNESS))
/** The recorder's own directories, out of the watcher's reach (`IGNORED_BY_WATCH`). */
const IGNORED_BY_WATCH = ['<rootDir>/.harness-out/', '<rootDir>/.jest-cache/']

// The harness's watch pieces, loaded by path: `provino` may not import `@provino/harness`.
type ScmStep =
  | { readonly git: readonly string[] }
  | { readonly commit: string }
  | { readonly branch: string }
  | { readonly checkout: string }
  | { readonly write: Readonly<Record<string, string>> }
  | { readonly remove: readonly string[] }
type WatchStep =
  | { readonly waitRun: number }
  | { readonly waitText: string }
  | { readonly key: string }
  | { readonly type: string }
  | { readonly write: Readonly<Record<string, string>> }
  | { readonly remove: readonly string[] }
  | { readonly scm: readonly ScmStep[] }
  | { readonly captureFile: string }
  | { readonly exit: number }
interface PtyExit {
  readonly exitCode: number | null
  readonly killed: boolean
}
type PtyMatch = string | ((output: string) => number)
interface Session {
  write(text: string): void
  readonly output: () => string
  waitFor(match: PtyMatch, from?: number): Promise<number>
  readonly exit: Promise<PtyExit>
}
interface PtyProcess extends Session {
  readonly childPgid: number
  readonly relayPgid: number
  kill(): Promise<void>
}
interface Harness {
  runWatchSteps(
    steps: readonly WatchStep[],
    host: {
      readonly session: Session
      waitRuns(count: number): Promise<void>
      change(step: ScmStep): Promise<void>
      captureFile(file: string, key: string): Promise<Json>
    },
  ): Promise<{
    readonly runs: number
    readonly exit?: PtyExit
    readonly captures: Readonly<Record<string, Json>>
  }>
  /** What Jest prints, once per run, after it has written `--outputFile`. */
  readonly RESULTS_WRITTEN: string
  watchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv
  renderTranscript(output: string): string
  maskTimes(text: string): string
  spawnPty(
    argv: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; deadline?: AbortSignal },
  ): Promise<PtyProcess>
  spawnPiped(
    argv: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; deadline?: AbortSignal },
  ): Promise<PtyProcess>
  groupExists(pgid: number): boolean
}

async function harness(): Promise<Harness> {
  const [steps, transcript, record, pty] = await Promise.all([
    import(new URL('internal/watch-steps.ts', HARNESS).href),
    import(new URL('internal/watch-transcript.ts', HARNESS).href),
    import(new URL('internal/watch-record.ts', HARNESS).href),
    import(new URL('pty.ts', HARNESS).href),
  ])
  return {
    runWatchSteps: steps.runWatchSteps,
    RESULTS_WRITTEN: steps.RESULTS_WRITTEN,
    watchEnv: record.watchEnv,
    renderTranscript: transcript.renderTranscript,
    maskTimes: transcript.maskTimes,
    spawnPty: pty.spawnPty,
    spawnPiped: pty.spawnPiped,
    groupExists: pty.groupExists,
  }
}
const H = await harness()

/** What Jest prints, once per run, after it has written `--outputFile` (the harness's own). */
export const RESULTS_WRITTEN: string = H.RESULTS_WRITTEN

/** `runJestCommand`'s inputs that these tests give (the type-test project leaves `src/` out). */
interface JestCommandIo {
  readonly stdout: { write(chunk: string): unknown }
  readonly stderr: NodeJS.WritableStream
  readonly cwd: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly signal?: AbortSignal
  readonly onForceExit?: () => void
  readonly stdin?: {
    readonly setRawMode?: (mode: boolean) => unknown
    resume(): unknown
    pause(): unknown
    setEncoding(encoding: 'utf8'): unknown
    on(event: 'data', listener: (chunk: string) => void): unknown
    off(event: 'data', listener: (chunk: string) => void): unknown
  }
  readonly watchChanges?: (sink: {
    readonly event: (event: {
      readonly kind: 'add' | 'change' | 'unlink'
      readonly path: string
      readonly mtimeMs: number | undefined
    }) => void
    readonly error: (error: unknown) => void
  }) => { close(): void }
}
type RunJestCommand = (args: readonly string[], io: JestCommandIo) => Promise<number>
const loaded = (await import(new URL('../src/internal/jest-command.ts', import.meta.url).href)) as {
  readonly runJestCommand: RunJestCommand
}
export const runJestCommand: RunJestCommand = loaded.runJestCommand

// The in-process runs look the fixture's repository up with this process's git: hermetic, as the
// recorder's, with the ceiling at the work directories' parent.
for (const [name, value] of Object.entries(gitEnv(await realpath(tmpdir()))))
  process.env[name] = value
for (const name of Object.keys(process.env)) {
  if (name.startsWith('GIT_') && !(name in gitEnv('/'))) delete process.env[name]
}

interface WatchManifest {
  readonly scm?: { readonly steps: readonly ScmStep[] }
  readonly watch: {
    /** B23e: Jest gets exactly `argv` (an editor's line); the config is the project's own. */
    readonly exact?: true
    readonly timeKeys?: readonly string[]
    readonly maskKeys?: readonly string[]
    readonly argv: readonly string[]
    readonly tty: boolean
    readonly steps: readonly WatchStep[]
    readonly capture: readonly string[]
    readonly keepLines?: string
    readonly mask?: readonly string[]
  }
}
export interface WatchObserved {
  readonly exitCode?: number | null
  readonly runs?: readonly unknown[]
  readonly transcript?: string
  readonly json?: Readonly<Record<string, Json | null>>
}

/** The recorder's deadline for a whole session. */
export const SESSION_MS = 120_000
const POLL_MS = 25

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The fixture's work directory as the recorder leaves it before the session starts. */
/** A fixture's project, written and ready for a session. */
export interface Prepared {
  readonly manifest: RecordedFixture['manifest'] & WatchManifest
  readonly project: Materialized
  readonly root: string
  readonly configFile: string
  readonly runLog: string
}

export async function prepare(
  fixture: RecordedFixture,
  options: PlayOptions = {},
): Promise<Prepared> {
  const manifest = fixture.manifest as RecordedFixture['manifest'] & WatchManifest
  const project = await materialize(fixture)
  const { root } = project
  // A package the fixture's config names, from this package's own install (a devDependency), as
  // the recorder's project finds it from the harness's. Linked, not copied: its own dependencies
  // resolve from where it is installed.
  for (const name of options.link ?? []) {
    const target = join(root, 'node_modules', name)
    await mkdir(dirname(target), { recursive: true })
    await symlink(await realpath(join(PACKAGE_MODULES, name)), target, 'dir')
  }
  const outDir = join(root, '.harness-out')
  await mkdir(outDir)
  const exact = manifest.watch.exact === true
  const runLog = join(outDir, 'runs.jsonl')
  const base = JSON.parse(await readFile(join(root, 'jest.config.json'), 'utf8')) as Record<
    string,
    unknown
  >
  const ignored = Array.isArray(base.watchPathIgnorePatterns) ? base.watchPathIgnorePatterns : []
  // An exact session has no `--config`: Jest finds the project's own `jest.config.json`, and its
  // command line's `--reporters` replace the config's (the run log's goes on the line instead).
  const configFile = exact ? join(root, 'jest.config.json') : join(outDir, 'jest.config.json')
  if (!exact) await rm(join(root, 'jest.config.json'))
  await writeFile(
    configFile,
    `${JSON.stringify(
      {
        ...base,
        ...(exact ? {} : { reporters: ['default', [WATCH_LOG_REPORTER, { outputFile: runLog }]] }),
        watchPathIgnorePatterns: [...ignored, ...IGNORED_BY_WATCH],
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(runLog, '')
  if (manifest.scm !== undefined) {
    await initRepo(root)
    for (const step of manifest.scm.steps) await applyStep(root, step)
  }
  return { manifest, project, root, configFile, runLog }
}

/** This package's `node_modules`. */
const PACKAGE_MODULES = fileURLToPath(new URL('../node_modules/', import.meta.url))

/** How a fixture is played. */
export interface PlayOptions {
  /** Packages linked into the project's `node_modules` from this package's. */
  readonly link?: readonly string[]
  /** Names what differs in a captured results file, ahead of the whole-file comparison. */
  readonly compareCapture?: CaptureComparator
}

/** One `scm`, `write` or `remove` step; returns the paths it wrote or removed. */
async function applyStep(
  root: string,
  step: ScmStep,
): Promise<readonly { readonly path: string; readonly removed: boolean }[]> {
  if ('git' in step) git(root, step.git)
  else if ('commit' in step) commitAll(root, step.commit)
  else if ('branch' in step) git(root, ['checkout', '-q', '-b', step.branch])
  else if ('checkout' in step) git(root, ['checkout', '-q', step.checkout])
  else if ('write' in step) {
    const written = []
    for (const [file, text] of Object.entries(step.write)) {
      await mkdir(dirname(join(root, file)), { recursive: true })
      await writeFile(join(root, file), text)
      written.push({ path: join(root, file), removed: false })
    }
    return written
  } else {
    for (const file of step.remove) await rm(join(root, file), { recursive: true, force: true })
    return step.remove.map((file) => ({ path: join(root, file), removed: true }))
  }
  return []
}

function completeLines(text: string): number {
  return text
    .split('\n')
    .slice(0, -1)
    .filter((line) => line !== '').length
}

/**
 * `waitRuns` as the recorder's, with the done plugin's file replaced by the driver's own sign: once
 * the log holds `count` runs, the output written since the last key or change holds `Watch Usage`
 * (the usage, or the line that stands for it), which the driver writes after `isRunning` is off.
 */
function runWaiter(options: {
  readonly runLog: string
  readonly session: Session
  readonly interactive: boolean
  readonly mark: () => number
  readonly ended: () => boolean
  /** When the whole session's budget ends (default: `SESSION_MS` from each wait). */
  readonly until?: number
}) {
  return async (count: number): Promise<void> => {
    const deadline = options.until ?? Date.now() + SESSION_MS
    for (;;) {
      const seen = completeLines(await readFile(options.runLog, 'utf8'))
      if (seen > count) {
        throw new Error(`the run log holds ${seen} runs where a step waits for ${count}`)
      }
      const done =
        !options.interactive ||
        options.session.output().slice(options.mark()).includes('Watch Usage')
      if (seen === count && done) return
      if (options.ended() || Date.now() > deadline) {
        throw new Error(
          `${options.ended() ? 'the session ended' : 'the deadline passed'} with ${seen} of ${count} runs. Output tail:\n${options.session.output().slice(-2000)}`,
        )
      }
      await sleep(POLL_MS)
    }
  }
}

/** The golden's captures, from what the session left. */
async function observe(
  manifest: WatchManifest,
  root: string,
  runLog: string,
  output: string,
  exitCode: number | null | undefined,
  json: Readonly<Record<string, Json>> = {},
): Promise<WatchObserved> {
  const { watch } = manifest
  const rooted = (text: string): string => text.replaceAll(root, '<root>')
  const captured = (name: string): boolean => watch.capture.includes(name)
  const runs = (await readFile(runLog, 'utf8'))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(rooted(line)) as unknown)
  let transcript: string | undefined
  if (captured('transcript')) {
    let lines = H.maskTimes(H.renderTranscript(rooted(output))).split('\n')
    for (const pattern of watch.mask ?? []) {
      lines = lines.map((line) => line.replace(new RegExp(pattern, 'gm'), '<masked>'))
    }
    if (watch.keepLines !== undefined) {
      const keep = new RegExp(watch.keepLines)
      lines = lines.filter((line) => keep.test(line))
    }
    transcript = lines.join('\n')
  }
  return {
    ...(captured('exitCode') ? { exitCode: exitCode ?? null } : {}),
    ...(Object.keys(json).length === 0 ? {} : { json }),
    ...(captured('runs') ? { runs } : {}),
    ...(transcript === undefined ? {} : { transcript }),
  }
}

/** The step host's `captureFile`, for a play that has no results file to read. */
const NO_CAPTURE = async (): Promise<never> => {
  throw new Error('a captureFile step needs a play on the bin (playOnTerminal, playPiped)')
}

/** What a `captureFile` step reads: the file, parsed, as the golden keeps it (roots, times, masks). */
function captureReader(manifest: WatchManifest, root: string): (file: string) => Promise<Json> {
  const { watch } = manifest
  return async (file) =>
    normalizedJson(JSON.parse(await readFile(join(root, file), 'utf8')) as Json, {
      roots: [root],
      timeKeys: watch.timeKeys ?? [],
      maskKeys: watch.maskKeys ?? [],
      mask: watch.mask ?? [],
    })
}

/**
 * Compares one captured results file with the golden's and says what differs. It runs before the
 * whole-file comparison, which stays: a difference it does not name still fails there.
 */
export type CaptureComparator = (
  key: string,
  actual: Json | null | undefined,
  expected: Json | null,
) => void

function assertObserved(
  actual: WatchObserved,
  fixture: RecordedFixture,
  compareCapture?: CaptureComparator,
): void {
  const expected = (fixture.golden.observed ?? {}) as WatchObserved
  if (expected.runs !== undefined) assert.deepEqual(actual.runs, expected.runs, 'the run log')
  if (expected.transcript !== undefined) {
    assert.equal(actual.transcript, expected.transcript, 'the kept transcript lines')
  }
  if (expected.json !== undefined) {
    assert.deepEqual(
      Object.keys(actual.json ?? {}),
      Object.keys(expected.json),
      'the captured files',
    )
    for (const [key, value] of Object.entries(expected.json)) {
      compareCapture?.(key, actual.json?.[key], value)
      assert.deepEqual(actual.json?.[key], value, `the results file, ${key}`)
    }
  }
  if ('exitCode' in expected) assert.equal(actual.exitCode, expected.exitCode, 'the exit code')
}

/** A terminal for one process (or, `tty: false`, a pipe): what is written to it, 120 columns. */
export class FakeTerminal extends Writable {
  text = ''
  readonly isTTY: boolean
  readonly columns = 120
  readonly rows = 40
  constructor(tty = true) {
    super()
    this.isTTY = tty
  }
  override _write(chunk: Buffer | string, _encoding: string, callback: () => void): void {
    this.text += String(chunk)
    callback()
  }
}

/** A terminal's input in raw mode: what a test types arrives as one `data` chunk. */
export class FakeStdin extends EventEmitter {
  isRaw = false
  setRawMode(mode: boolean): this {
    this.isRaw = mode
    return this
  }
  resume(): this {
    return this
  }
  pause(): this {
    return this
  }
  setEncoding(): this {
    return this
  }
}

/** Input that is not a terminal (`setRawMode` is undefined). */
const PIPE_STDIN: NonNullable<JestCommandIo['stdin']> = {
  resume: () => undefined,
  pause: () => undefined,
  setEncoding: () => undefined,
  on: () => undefined,
  off: () => undefined,
}

/** Plays a fixture against `runJestCommand` in this process. */
export async function playInProcess(
  fixture: RecordedFixture,
  options: PlayOptions = {},
): Promise<void> {
  const { manifest, project, root, configFile, runLog } = await prepare(fixture, options)
  const interactive = manifest.watch.tty
  const terminal = new FakeTerminal(interactive)
  const stdin = new FakeStdin()
  let sink:
    | {
        readonly event: (event: {
          kind: 'add' | 'change' | 'unlink'
          path: string
          mtimeMs: number | undefined
        }) => void
      }
    | undefined
  const controller = new AbortController()
  let ended = false
  let mark = 0
  // `--ci=false`: the recorder's `watchEnv` has `CI=false`, and the config reader reads `CI` from
  // the process (GitHub's runners set it), which would turn the live `RUNS` block off.
  const exit = runJestCommand(['--config', configFile, '--ci=false', ...manifest.watch.argv], {
    stdout: terminal,
    stderr: terminal,
    cwd: root,
    // jest-util's `isInteractive` reads these; `NO_COLOR` as the recorder runs Jest.
    env: { TERM: 'xterm-256color', NO_COLOR: '1' },
    // Not a terminal: an input with no raw mode, which Jest reads no key from.
    stdin: interactive ? stdin : PIPE_STDIN,
    signal: controller.signal,
    watchChanges: (given) => {
      sink = given
      return { close: () => {} }
    },
  }).then((code) => {
    ended = true
    return { exitCode: code, killed: false }
  })
  const session: Session = {
    write: (text) => {
      mark = terminal.text.length
      stdin.emit('data', text)
    },
    output: () => terminal.text,
    waitFor: async (match, from = 0) => {
      const deadline = Date.now() + SESSION_MS
      for (;;) {
        const text = terminal.text
        const at =
          typeof match === 'string'
            ? ((found) => (found === -1 ? -1 : found + match.length))(text.indexOf(match, from))
            : match(text)
        if (at !== -1) return at
        if (ended || Date.now() > deadline) {
          throw new Error(`never saw ${String(match)}. Output tail:\n${text.slice(-2000)}`)
        }
        await sleep(POLL_MS)
      }
    },
    exit,
  }
  try {
    const result = await H.runWatchSteps(manifest.watch.steps, {
      session,
      captureFile: NO_CAPTURE,
      waitRuns: runWaiter({ runLog, session, interactive, mark: () => mark, ended: () => ended }),
      change: async (step) => {
        mark = terminal.text.length
        for (const changed of await applyStep(root, step)) {
          const mtimeMs = changed.removed ? undefined : (await stat(changed.path)).mtimeMs
          sink?.event({ kind: changed.removed ? 'unlink' : 'change', path: changed.path, mtimeMs })
        }
      },
    })
    if (result.exit === undefined) controller.abort()
    const ending = await exit
    assertObserved(
      await observe(
        manifest,
        root,
        runLog,
        terminal.text,
        result.exit?.exitCode ?? ending.exitCode,
      ),
      fixture,
    )
  } finally {
    controller.abort()
    await exit
    assert.equal(stdin.isRaw, false, 'raw mode is left')
    await project.dispose()
  }
}

/**
 * Why the terminal runs can't be done here: no terminal to open (`/dev/ptmx` denied) or no file
 * events. `false` runs them; with `CI` set a reason is an error, never a skip.
 */
export async function terminalSkip(): Promise<string | false> {
  return skipReason(true)
}

/** `terminalSkip` for a session on a pipe: only the file events (`fs.watch`) are needed. */
export async function watcherSkip(): Promise<string | false> {
  return skipReason(false)
}

async function skipReason(needTerminal: boolean): Promise<string | false> {
  const reasons: string[] = []
  if (needTerminal) {
    try {
      const probe = await H.spawnPty(['/bin/echo', 'ready'], {
        cwd: process.cwd(),
        env: process.env,
      })
      await probe.exit
      await probe.kill()
    } catch (error) {
      reasons.push(`no terminal: ${(error as Error).message.split('\n')[0]}`)
    }
  }
  const { watch } = await import('node:fs')
  const dir = await mkdtemp(join(tmpdir(), 'provino-watch-probe-'))
  const event = await new Promise<string | undefined>((resolve) => {
    const timer = setTimeout(() => resolve('fs.watch reported no event'), 5_000)
    try {
      const handle = watch(dir, { recursive: process.platform !== 'linux' }, () => {
        clearTimeout(timer)
        handle.close()
        resolve(undefined)
      })
      handle.on('error', (error) => {
        clearTimeout(timer)
        handle.close()
        resolve(`fs.watch failed: ${error.message}`)
      })
      void writeFile(join(dir, 'probe.txt'), 'x')
    } catch (error) {
      clearTimeout(timer)
      resolve(`fs.watch threw: ${(error as Error).message}`)
    }
  })
  await rm(dir, { recursive: true, force: true })
  if (event !== undefined) reasons.push(event)
  if (reasons.length === 0) return false
  const reason = reasons.join('; ')
  if (isCi(process.env)) {
    throw new Error(`${reason}, and in CI the terminal watch tests must run`)
  }
  return `${reason} (a sandbox): CI runs these`
}

/** The recorder's `watchEnv` over the bin's environment, with the harness's hermetic git. */
function terminalEnv(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(outputFree()).filter(([name]) => !name.startsWith('GIT_')),
    ),
    ...gitEnv(dirname(root)),
    CI: 'false',
    TERM: 'xterm-256color',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  }
  for (const name of ['TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'COLORTERM']) delete env[name]
  return env
}

/**
 * Runs a play, then its cleanup, whatever the play did. The play's own error is the one thrown;
 * a cleanup that fails after a play that passed is thrown in its place.
 */
export async function guarded<T>(play: () => Promise<T>, end: () => Promise<void>): Promise<T> {
  let value: T
  try {
    value = await play()
  } catch (error) {
    await end().catch(() => undefined)
    throw error
  }
  await end()
  return value
}

/**
 * Ends a session whatever happened: kills it, checks that its two process groups are gone, and
 * always disposes of the project. The first error is the one that is thrown.
 */
export async function endSession(
  session: PtyProcess | undefined,
  dispose: () => Promise<void>,
  groupGone: (pgid: number) => boolean = (pgid) => !H.groupExists(pgid),
): Promise<void> {
  await guarded(async () => {
    if (session === undefined) return
    await session.kill()
    assert.equal(groupGone(session.childPgid), true, 'the bin group is gone')
    assert.equal(groupGone(session.relayPgid), true, 'the relay group is gone')
  }, dispose)
}

/** How a session on the bin is started. */
interface SessionKind {
  /** `spawnPty` (a terminal from the pty relay) or `spawnPiped` (a pipe, an editor's child). */
  readonly spawn: Harness['spawnPty']
  readonly argv: readonly string[]
  readonly env: NodeJS.ProcessEnv
  /**
   * A terminal: a run is over once the driver has drawn its usage after the last key or change.
   * On a pipe the run log alone says so.
   */
  readonly interactive: boolean
}

/**
 * Plays a fixture's steps against a session on the bin, with the real watcher, in a process group
 * of its own that is killed and probed whatever happens. The whole session has one budget,
 * `SESSION_MS`, which ends in an ordinary error with the output's tail. A `captureFile` step reads
 * its results file once the harness's steps have seen Jest say it wrote it.
 */
async function playSession(
  fixture: RecordedFixture,
  prepared: Prepared,
  kind: SessionKind,
  compareCapture?: CaptureComparator,
): Promise<WatchObserved> {
  const { manifest, project, root, runLog } = prepared
  const deadline = AbortSignal.timeout(SESSION_MS)
  const until = Date.now() + SESSION_MS
  let pty: PtyProcess | undefined
  return guarded(
    async () => {
      const live = await kind.spawn(kind.argv, { cwd: root, env: kind.env, deadline })
      pty = live
      let ended = false
      const end = (): void => {
        ended = true
      }
      void live.exit.then(end, end)
      let mark = 0
      const session: Session = {
        write: (text) => {
          mark = live.output().length
          live.write(text)
        },
        output: live.output,
        waitFor: live.waitFor.bind(live),
        exit: live.exit,
      }
      const result = await H.runWatchSteps(manifest.watch.steps, {
        session,
        captureFile: captureReader(manifest, root),
        waitRuns: runWaiter({
          runLog,
          session,
          interactive: kind.interactive,
          mark: () => mark,
          ended: () => ended,
          until,
        }),
        change: async (step) => {
          mark = live.output().length
          await applyStep(root, step)
        },
      })
      const observed = await observe(
        manifest,
        root,
        runLog,
        live.output(),
        result.exit?.exitCode,
        result.captures,
      )
      assertObserved(observed, fixture, compareCapture)
      return observed
    },
    () => endSession(pty, () => project.dispose()),
  )
}

/** Plays a fixture against the bin on a terminal from the pty relay, with the real watcher. */
export async function playOnTerminal(
  fixture: RecordedFixture,
  options: PlayOptions = {},
): Promise<void> {
  const prepared = await prepare(fixture, options)
  const { manifest, root, configFile } = prepared
  await playSession(
    fixture,
    prepared,
    {
      spawn: H.spawnPty,
      argv: [
        process.execPath,
        '--conditions=provino-source',
        CLI,
        'jest',
        '--config',
        configFile,
        ...manifest.watch.argv,
      ],
      env: terminalEnv(root),
      interactive: true,
    },
    options.compareCapture,
  )
}

/**
 * The environment of an editor's child as the recorder gives it: the recorder's own
 * (`replayEnv`: its base with `TZ=UTC` and the locale, the hermetic git, the fixture's `env` with
 * each `null` removed), then the harness's `watchEnv` (`record.ts` L585-L600, `watch-record.ts`):
 * not a CI run, a terminal type that is not `dumb`, and `FORCE_COLOR=0`. Jest's chalk lets that
 * variable override the `--colors` the fixture's argv passes (supports-color 7.2.0, index.js
 * L21-L29, L45), so both runners are plain.
 */
function pipedEnv(
  root: string,
  manifest: WatchManifest & RecordedFixture['manifest'],
): NodeJS.ProcessEnv {
  return H.watchEnv(replayEnv(manifest, root))
}

/**
 * Plays a `tty: false` fixture against the bin on a pipe in a process group of its own, with the
 * real watcher: an editor's child. An exact session is given the fixture's `argv` as it is, with
 * the run log's reporter added on the command line, as the recorder adds it. A `captureFile` step
 * reads the results file once Jest has said it wrote it (the reporters finish before Jest writes
 * the file): the n-th `Test results written to` line for the n-th capture, which the harness's
 * steps wait for. `compareCapture` names what differs in each file, ahead of the whole comparison.
 */
export async function playPiped(
  fixture: RecordedFixture,
  options: PlayOptions = {},
): Promise<WatchObserved> {
  const prepared = await prepare(fixture, options)
  const { manifest, root, configFile, runLog } = prepared
  const exact = manifest.watch.exact === true
  assert.equal(manifest.watch.tty, false, 'playPiped plays a fixture with tty: false')
  return playSession(
    fixture,
    prepared,
    {
      spawn: H.spawnPiped,
      argv: [
        process.execPath,
        '--conditions=provino-source',
        CLI,
        'jest',
        ...(exact ? [] : ['--config', configFile]),
        ...manifest.watch.argv,
        ...(exact ? ['--reporters', WATCH_LOG_REPORTER] : []),
      ],
      env: { ...pipedEnv(root, manifest), PROVINO_WATCH_LOG: runLog },
      interactive: false,
    },
    options.compareCapture,
  )
}
