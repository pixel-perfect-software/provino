// Helpers for the tests: a small Jest-style project written to $TMPDIR as text (no `.js` is
// committed, D13), a collecting stream, and a deadline for child processes.
import assert from 'node:assert/strict'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Writable } from 'node:stream'
import { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AGENT_VARIABLES } from '@provino/reporters'
import { killGroup } from './sweep.ts'

// What picks the reporters, and whether the text is coloured, comes from the environment: an agent
// (`CLAUDECODE`, `AI_AGENT`, ...) gets the `agent` reporter, GitHub Actions gets `github-actions`
// beside `default`, and `FORCE_COLOR` colours it. The tests assert on `default`'s plain text, and
// they run under an agent's shell and on GitHub's runners, so none of it may leak in: this process
// and every child it starts (they inherit `process.env`) run without. A test that wants one of them
// sets it for its own child (`spawnCli`'s `env`) or passes `env` to `run()`.
for (const name of [
  ...AGENT_VARIABLES.map(([, variable]) => variable),
  'AI_AGENT',
  'GITHUB_ACTIONS',
  'GITHUB_WORKSPACE',
  'FORCE_COLOR',
  'NO_COLOR',
]) {
  delete process.env[name]
}

/** A writable that keeps everything written to it. */
export class Collect extends Writable {
  text = ''
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.text += chunk.toString()
    done()
  }
}

/** A temporary project directory; `cleanup` removes it. */
export interface Project {
  /** Real path of the directory, so the paths in output agree on every platform. */
  readonly dir: string
  /** The absolute path of `name` in the project. */
  path(name: string): string
  /** The project's config file. */
  readonly config: string
  cleanup(): Promise<void>
}

/** The config every generated project has. */
const CONFIG = "export default { dialect: 'jest', include: ['tests/**/*.test.js'] }\n"

/** The files of a project: name → text, or a function of the project's directory that gives them. */
export type ProjectFiles =
  | Readonly<Record<string, string>>
  | ((dir: string) => Readonly<Record<string, string>>)

/**
 * Writes a project into a new temporary directory: `files` (name → text, usually under `tests/`),
 * a `provino.config.mjs` for the Jest dialect that finds `tests/**\/*.test.js`, and a CommonJS
 * `package.json`, so the test files can be plain scripts. `config` replaces the config's text. A
 * function of the directory lets a test file refer to a path inside it.
 */
export async function makeProject(files: ProjectFiles, config: string = CONFIG): Promise<Project> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'provino-run-')))
  const all = {
    'package.json': '{"type":"commonjs"}\n',
    'provino.config.mjs': config,
    ...(typeof files === 'function' ? files(dir) : files),
  }
  for (const [name, text] of Object.entries(all)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), text)
  }
  return {
    dir,
    path: (name) => join(dir, name),
    config: join(dir, 'provino.config.mjs'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

/**
 * A maker of projects for one test file: each project it makes is removed once the file's tests
 * are done. It registers its own `after`, so call it once, at the top of the file.
 */
export function trackedProjects(): typeof makeProject {
  const made: Project[] = []
  after(async () => {
    await Promise.all(made.map((project) => project.cleanup()))
  })
  return async (files, config) => {
    const project = await makeProject(files, config)
    made.push(project)
    return project
  }
}

/** A test file with one passing test. */
export function passing(name: string): string {
  return `test(${JSON.stringify(name)}, () => { expect(1 + 1).toBe(2) })\n`
}

/** A test file with one failing test. */
export function failing(name: string): string {
  return `test(${JSON.stringify(name)}, () => { expect(1 + 1).toBe(3) })\n`
}

/** A test file with one passing test that notes the worker's pid in `pidFile`. */
export function noting(name: string, pidFile: string): string {
  return [
    "const { appendFileSync } = require('node:fs')",
    `test(${JSON.stringify(name)}, () => {`,
    `  appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n')`,
    '  expect(1 + 1).toBe(2)',
    '})',
    '',
  ].join('\n')
}

/** The pids a project's test files noted in `pidFile` (none if no file ran). */
export async function notedPids(pidFile: string): Promise<readonly number[]> {
  const text = await readFile(pidFile, 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).map(Number)
}

/** Whether a process with this pid is still there (a reaped child is not). */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The `provino` bin's source. */
export const CLI: string = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

/** How a child process ended, and what it wrote. */
export interface Spawned {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

/** What `startCli` and `spawnCli` take. */
export interface CliOptions {
  /** Where the bin runs. Default: the temp dir. */
  readonly cwd?: string
  /** A process still running after this is killed (with its group, when `detached`). Default 90 s. */
  readonly deadlineMs?: number
  /** In a process group of its own, so a sweep can tell what it left behind. */
  readonly detached?: boolean
  /** Added to this process's environment. */
  readonly env?: Readonly<Record<string, string>>
  /** Node flags before the bin (`--import <preload>`). */
  readonly nodeArgs?: readonly string[]
}

/** A bin process that is running, and how to follow it. */
export interface LiveCli {
  readonly child: ChildProcess
  /** The process group the bin leads when it is `detached`: what a sweep looks at. */
  readonly pgid: number
  stdout(): string
  stderr(): string
  /** Resolves when the process has exited (it is killed after the deadline, so it always does). */
  readonly exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>
  /**
   * Resolves with everything it wrote once its stdio has closed too, or rejects when the deadline
   * had to kill it.
   */
  result(): Promise<Spawned>
}

/** How a child process ended, and what it wrote. */
export interface Spawned {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Starts `provino <args>` as a child process. A process still running after the deadline is killed
 * (with its whole group when it is `detached`), so a `provino` that does not end cannot hang the
 * suite.
 */
export function startCli(args: readonly string[], options: CliOptions = {}): LiveCli {
  const { cwd = tmpdir(), deadlineMs = 90_000, detached = false, env = {}, nodeArgs = [] } = options
  const child = spawn(
    process.execPath,
    ['--conditions=provino-source', ...nodeArgs, CLI, ...args],
    { cwd, detached, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } },
  )
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const pgid = child.pid as number
  let overran = false
  const deadline = setTimeout(() => {
    overran = true
    if (detached) killGroup(pgid)
    else child.kill('SIGKILL')
  }, deadlineMs)
  const exited = once(child, 'exit').then(([code, signal]) => {
    clearTimeout(deadline)
    return { code: code as number | null, signal: signal as NodeJS.Signals | null }
  })
  return {
    child,
    pgid,
    stdout: () => stdout,
    stderr: () => stderr,
    exited,
    result: () =>
      new Promise((resolve, reject) => {
        child.once('error', (error) => {
          clearTimeout(deadline)
          reject(error)
        })
        child.once('close', (code, signal) => {
          clearTimeout(deadline)
          if (overran) {
            reject(
              new Error(
                `provino did not exit within ${deadlineMs} ms\nstdout: ${stdout}\nstderr: ${stderr}`,
              ),
            )
          } else resolve({ code, signal, stdout, stderr })
        })
      }),
  }
}

/** Runs `provino <args>` as a child process and resolves when it has exited on its own. */
export function spawnCli(args: readonly string[], options: CliOptions = {}): Promise<Spawned> {
  return startCli(args, options).result()
}

/** One file of a `normalized-json` run, as the tests assert on it. */
export interface NormalizedFileView {
  readonly status: unknown
  /** The file's error as text, or `undefined`. */
  readonly fileError: string | undefined
  /** Each test's status by its path (`describe > test`). */
  readonly tests: ReadonlyMap<string, unknown>
}

/** The parts of a `normalized-json` file the tests assert on. */
export interface NormalizedView {
  readonly schemaVersion: unknown
  readonly runner: unknown
  readonly suite: unknown
  readonly success: unknown
  /** The run's `env.ci`. */
  readonly ci: unknown
  readonly files: ReadonlyMap<string, NormalizedFileView>
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown, what: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) assert.fail(`${what} should be an object`)
  return value
}

function list(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) assert.fail(`${what} should be an array`)
  return value
}

/** Reads a `normalized-json` file's text, asserting the shape the tests rely on. */
export function viewOfNormalized(text: string): NormalizedView {
  const run = record(JSON.parse(text), 'the run')
  const files = new Map<string, NormalizedFileView>()
  for (const entry of list(run.files, 'files')) {
    const file = record(entry, 'a file')
    const tests = new Map<string, unknown>()
    for (const item of list(file.tests, 'tests')) {
      const test = record(item, 'a test')
      const id = record(test.id, 'a test id')
      tests.set(list(id.path, 'a test path').join(' > '), test.status)
    }
    const error = file.fileError === undefined ? undefined : record(file.fileError, 'a file error')
    files.set(String(file.file), {
      status: file.status,
      fileError: error === undefined ? undefined : String(error.message),
      tests,
    })
  }
  return {
    schemaVersion: run.schemaVersion,
    runner: run.runner,
    suite: run.suite,
    success: run.success,
    ci: record(run.env, 'env').ci,
    files,
  }
}

/** The built bin (`pnpm build` writes it; turbo's `test` depends on that). */
export const BUILT_BIN: string = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

/**
 * A preload in this directory that a child runs before anything else (`--import`): see the files.
 * Each is read as text and passed as a `data:` URL, so it is plain JavaScript (no type syntax)
 * and the child never loads a `.ts` file: on Node 22.15, which CI runs with
 * `NODE_OPTIONS=--experimental-strip-types`, stripping types prints an ExperimentalWarning to the
 * child's stderr, and the tests assert on that stream.
 */
export type Preload = 'block-oxc-bindings' | 'load-recorder'

/**
 * The environment of a child that runs the built package: this process's, then `env`, with each
 * preload added to `NODE_OPTIONS` after whatever the parent already set. The one place that
 * composes it.
 */
export function childEnv(
  preloads: readonly Preload[] = [],
  env: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const imports = preloads.map((name) => {
    const source = readFileSync(fileURLToPath(new URL(`./${name}.ts`, import.meta.url)), 'utf8')
    return `--import=data:text/javascript,${encodeURIComponent(source)}`
  })
  return {
    ...process.env,
    ...env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, ...imports].filter(Boolean).join(' '),
  }
}

/** Runs the built bin to the end from `cwd`, with the preloads and `env` of `childEnv`. */
export function runBuilt(
  args: readonly string[],
  options: {
    readonly cwd: string
    readonly preloads?: readonly Preload[]
    readonly env?: NodeJS.ProcessEnv
  },
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(process.execPath, [BUILT_BIN, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: childEnv(options.preloads, options.env),
    timeout: 120_000,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}
