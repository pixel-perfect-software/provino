// Helpers for the tests: a small Jest-style project written to $TMPDIR as text (no `.js` is
// committed, D13), a collecting stream, and a deadline for child processes.
import assert from 'node:assert/strict'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { once as nextEvent } from 'node:events'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { Writable } from 'node:stream'
import { after, describe as nodeDescribe, it as nodeIt } from 'node:test'
import { fileURLToPath } from 'node:url'
import { OUTPUT_VARIABLES } from '@provino/reporters'
import type { ProvinoApi } from 'provino'
import { killGroup } from './sweep.ts'

/** What the helpers here and in `recorded-run.ts` register on: the runner running the file. */
export interface TestRunner {
  readonly describe: (name: string, fn: () => void) => unknown
  readonly it: (name: string, fn: () => Promise<void>) => unknown
  readonly afterAll: (fn: () => Promise<void>) => unknown
}

/**
 * The runner that loaded this file. A Provino worker installs its native API at
 * `Symbol.for('provino.api')` (`PROVINO_API_SLOT`, `@provino/api`) as it boots, before any test file
 * loads; node:test installs nothing there. The bootstrap set keeps some of this package's files on
 * node:test (the canary always), and both halves import these helpers, so a helper that registers a
 * hook or a test asks this instead of importing one runner. The slot is read, not `provino`
 * imported, so a node:test file loads none of the runner it checks.
 */
export function testRunner(): TestRunner {
  const api = Reflect.get(globalThis, Symbol.for('provino.api')) as ProvinoApi | undefined
  if (api === undefined) return { describe: nodeDescribe, it: nodeIt, afterAll: after }
  return { describe: api.describe, it: api.it, afterAll: api.afterAll }
}

/**
 * What the helpers below made for the file that imported this module, removed once its tests are
 * done. The one hook is registered here, as the file loads (this module is evaluated once per test
 * file on either runner), so a helper may be called from a test, a describe body or a memoised
 * value a later test reuses, and its cleanup is the file's either way.
 */
const madeForFile: (() => unknown)[] = []
testRunner().afterAll(async () => {
  // Every cleanup runs, whatever another's fate: one that fails must not leave the rest behind.
  const settled = await Promise.allSettled(madeForFile.splice(0).map(async (cleanup) => cleanup()))
  const failed = settled.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  if (failed.length > 0) {
    throw new AggregateError(
      failed,
      `${failed.length} cleanup(s) of this file failed: ${failed.map((reason) => (reason instanceof Error ? reason.message : String(reason))).join('; ')}`,
    )
  }
})

/** Runs `cleanup` when the importing file's tests are done (see `madeForFile`). */
export function whenFileEnds(cleanup: () => unknown): void {
  madeForFile.push(cleanup)
}

/**
 * `make`, called by the first caller and its value kept for the rest: a resource a file's tests
 * share is made by the first test that needs it, never as the file loads (a listing imports it).
 */
export function once<T>(make: () => T): () => T {
  let made: { readonly value: T } | undefined
  return () => {
    made ??= { value: make() }
    return made.value
  }
}

// What picks the reporters, and whether the text is coloured, comes from the environment: an agent
// (`CLAUDECODE`, `AI_AGENT`, ...) gets the `agent` reporter, GitHub Actions gets `github-actions`
// beside `default`, and `FORCE_COLOR` colours it. The tests assert on `default`'s plain text, and
// they run under an agent's shell and on GitHub's runners, so none of it may leak in. This module
// leaves `process.env` alone: a child process starts from the environment of `outputFree`, an
// in-process `run()` is given `QUIET_ENV`. A test that wants one of the variables sets it for its
// own child (`env` of `spawnCli`, `childEnv`) or passes it as `env` to `run()`.

/** What an in-process run reads for the terminal, CI, an agent and colour: nothing. */
export const QUIET_ENV: Readonly<Record<string, string | undefined>> = {}

/** The directory an agent is found by on `PATH` (`detectOutput` reads it; the rest of `PATH` stays). */
const AGENT_PATH = /\.pi[\\/]agent/

/**
 * The package script running this suite, as npm and pnpm set it. Jest's Snapshot Summary names
 * the update command from them (`jestUpdateCommand`: `run \`npm test -- -u\`` when the script's
 * text names jest, else `re-run jest with \`-u\``), and this package's own `test` script names
 * its bootstrap files (`test/jest-colour.test.ts`, …), so under `pnpm test` a child would print
 * the npm hint where every recording has Jest's.
 */
const SCRIPT_VARIABLES: readonly string[] = ['npm_lifecycle_event', 'npm_lifecycle_script']

/**
 * `env` without anything `detectOutput` reads (`OUTPUT_VARIABLES`: `CI`, `TERM`, the colour
 * switches, `GITHUB_ACTIONS`, the agent variables), the workspace `github-actions` reads or the
 * update hint reads (`SCRIPT_VARIABLES`), and without the `PATH` entry that names an agent. A
 * child process starts from this.
 */
export function outputFree(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const kept = { ...env }
  for (const name of [...OUTPUT_VARIABLES, 'GITHUB_WORKSPACE', ...SCRIPT_VARIABLES]) {
    delete kept[name]
  }
  if (kept.PATH !== undefined) {
    kept.PATH = kept.PATH.split(delimiter)
      .filter((entry) => !AGENT_PATH.test(entry))
      .join(delimiter)
  }
  return kept
}

/**
 * The variables that make a run a CI one to anything in this process: `detectOutput`'s
 * (`OUTPUT_VARIABLES`) and the Jest config reader's CI list (`ciFromEnvironment`, ci-info's names:
 * `CI`, `GITHUB_ACTIONS`, `CONTINUOUS_INTEGRATION`, `BUILD_NUMBER`, …).
 */
const CI_VARIABLES: readonly string[] = [
  ...OUTPUT_VARIABLES,
  'BUILD_ID',
  'BUILD_NUMBER',
  'CI_APP_ID',
  'CI_BUILD_ID',
  'CI_BUILD_NUMBER',
  'CI_NAME',
  'CONTINUOUS_INTEGRATION',
  'RUN_ID',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'BUILDKITE',
  'TF_BUILD',
  'JENKINS_URL',
]

/**
 * `env` without any variable that makes a run a CI one (`CI_VARIABLES`), nor what `outputFree`
 * takes out: the environment of a child a test wants on an interactive terminal.
 */
export function interactiveEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const kept = outputFree(env)
  for (const name of CI_VARIABLES) delete kept[name]
  return kept
}

/**
 * Runs `work` with none of the CI and agent variables in this process's `process.env`, and puts
 * them back after, whatever `work` did. For a command run in this process that a test wants on an
 * interactive terminal: an in-process `runJestCommand` reads `CI` from `process.env` through the
 * Jest config reader, not from `io.env`, so on a CI runner (`CI=true`, `GITHUB_ACTIONS=true`) it
 * would be a CI run whatever the test passes. A test of the CI rule itself sets `CI` on purpose.
 */
export async function withoutCiEnvironment<T>(work: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string>()
  for (const name of CI_VARIABLES) {
    const value = process.env[name]
    if (value !== undefined) saved.set(name, value)
    delete process.env[name]
  }
  try {
    return await work()
  } finally {
    for (const [name, value] of saved) process.env[name] = value
  }
}

/**
 * What a process writes to stderr before the run's own text, with the lines Node and the sandbox
 * add taken out: Node 22.15 (CI runs it with `--experimental-strip-types`) prints an
 * `ExperimentalWarning` and a `--trace-warnings` hint once per process that loads a `.ts` file,
 * and some sandboxes print a certificate error at every Node start. For an assertion that anchors
 * on the start of stderr.
 */
export function withoutNodeNoise(stderr: string): string {
  return stderr
    .replaceAll(/^\(node:\d+\) ExperimentalWarning: .*\n/gm, '')
    .replaceAll(
      /^\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/gm,
      '',
    )
    .replaceAll(/ERROR: failed to copy trust settings of system certificate-\d+\n/g, '')
}

/** The escape character, as the coloured output has it. */
export const ESC: string = String.fromCharCode(27)

/**
 * The text of a Jest config that finds `tests/**\/*.test.js` (the files of `makeProject`), as JSON
 * for `--config`: `rootDir` is `dir` when given, and `extra` (more Jest keys) comes last.
 */
export function jestConfigJson(
  dir?: string,
  extra: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    ...(dir === undefined ? {} : { rootDir: dir }),
    testMatch: ['<rootDir>/tests/**/*.test.js'],
    ...extra,
  })
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
 * are done (`whenFileEnds`).
 */
export function trackedProjects(): typeof makeProject {
  return async (files, config) => {
    const project = await makeProject(files, config)
    whenFileEnds(project.cleanup)
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

/**
 * A test file with one passing test that notes the worker's pid in `pidFile`, after running
 * `before` (lines of the test's body).
 */
export function noting(name: string, pidFile: string, before: readonly string[] = []): string {
  return [
    "const { appendFileSync } = require('node:fs')",
    `test(${JSON.stringify(name)}, () => {`,
    `  appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n')`,
    ...before,
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
  /** Added to this process's environment, which has none of the variables that choose the output (`outputFree`). */
  readonly env?: Readonly<Record<string, string>>
  /** Node flags before the bin (`--import <preload>`). */
  readonly nodeArgs?: readonly string[]
  /**
   * The whole environment the bin starts from, in place of `outputFree()` (which `env` is still
   * added to). For a replay that builds its own, as the recorder builds the runner's.
   */
  readonly baseEnv?: NodeJS.ProcessEnv
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
  const {
    cwd = tmpdir(),
    deadlineMs = 90_000,
    detached = false,
    env = {},
    nodeArgs = [],
    baseEnv,
  } = options
  const child = spawn(
    process.execPath,
    ['--conditions=provino-source', ...nodeArgs, CLI, ...args],
    {
      cwd,
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...(baseEnv ?? outputFree()), ...env },
    },
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
  const exited = nextEvent(child, 'exit').then(([code, signal]) => {
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

/** The pools the native end-to-end tests run on. */
export const POOLS = ['forks', 'threads', 'inline'] as const

/**
 * Each file's error (or its tests' outcomes, joined), by file name, from the `results.json` that
 * `nativeRunArgs` makes in `dir`.
 */
export async function outcomesByFile(dir: string): Promise<ReadonlyMap<string, string>> {
  const view = viewOfNormalized(await readFile(join(dir, 'results.json'), 'utf8'))
  const found = new Map<string, string>()
  for (const [path, file] of view.files) {
    const name = path.split('/').at(-1) ?? path
    found.set(name, file.fileError ?? [...file.tests.values()].map(String).join(','))
  }
  return found
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
 * The environment of a child that runs the built package: this process's without the output
 * variables (`outputFree`), then `env`, with each
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
    ...outputFree(),
    ...env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, ...imports].filter(Boolean).join(' '),
  }
}

/**
 * Runs the built bin (`bin`, default this package's `dist/cli.js`) to the end from `cwd`, with
 * the preloads and `env` of `childEnv`.
 */
export function runBuilt(
  args: readonly string[],
  options: {
    readonly cwd: string
    readonly preloads?: readonly Preload[]
    readonly env?: NodeJS.ProcessEnv
    readonly bin?: string
  },
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(process.execPath, [options.bin ?? BUILT_BIN, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: childEnv(options.preloads, options.env),
    timeout: 120_000,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** Which bin a test runs: the source one (`spawnCli`) or the built one (`runBuilt`). */
export type BinKind = 'source' | 'built'

/** Runs `args` on the bin `kind` names, from `options.cwd`, to the end. */
export async function runBin(
  kind: BinKind,
  args: readonly string[],
  options: { readonly cwd: string },
): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
  if (kind === 'built') return runBuilt(args, options)
  const run = await spawnCli(args, options)
  return { status: run.code, stdout: run.stdout, stderr: run.stderr }
}

/**
 * `runBuilt` without blocking: the bin runs beside whatever else the caller starts, so cases that
 * each boot it can run together. Resolves with the exit status and the signal that ended it (one of
 * the two is null), never rejects for a failing run; a run that does not end in 120 s is killed and
 * reports its signal.
 */
export function runBuiltAsync(
  args: readonly string[],
  options: {
    readonly cwd: string
    readonly preloads?: readonly Preload[]
    readonly env?: NodeJS.ProcessEnv
    readonly bin?: string
  },
): Promise<{
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [options.bin ?? BUILT_BIN, ...args], {
      cwd: options.cwd,
      env: childEnv(options.preloads, options.env),
      timeout: 120_000,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }))
  })
}

/** One process's record from `load-recorder.ts`: its main module (`argv[1]`) and every URL it loaded, in order. */
export interface LoadLog {
  readonly main: string
  readonly urls: readonly string[]
}

/** The records `load-recorder.ts` wrote to `dir` (`PROVINO_LOAD_LOG`), one per process. */
export function readLoadLogs(dir: string): readonly LoadLog[] {
  return readdirSync(dir).map((file) => {
    const lines = readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean)
    return {
      main: lines[0]?.split('\t')[0] ?? '',
      urls: lines.map((line) => line.split('\t')[1] ?? ''),
    }
  })
}

/** Links `pkg` (default this package) as `<dir>/node_modules/provino`, as an install would put it. */
export function linkProvino(
  dir: string,
  pkg: string = fileURLToPath(new URL('..', import.meta.url)),
): void {
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  symlinkSync(pkg, join(dir, 'node_modules', 'provino'), 'dir')
}

/** This package's directory: the built package the copies below are made of. */
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

/**
 * Copies a built package (`dist` and `package.json`: this one's, or the package at `from`) into
 * `target`, as an install of its own at that path. Its dependencies are whatever `target`'s parents
 * hold. A package that is not built fails here, by name, instead of as a missing file later.
 */
export function copyBuiltPackage(target: string, from: string = PACKAGE_DIR): string {
  if (!existsSync(join(from, 'dist'))) {
    throw new Error(`${from} has no dist/: run \`pnpm build\` first`)
  }
  mkdirSync(target, { recursive: true })
  cpSync(join(from, 'dist'), join(target, 'dist'), { recursive: true })
  cpSync(join(from, 'package.json'), join(target, 'package.json'))
  return target
}

/** A temp directory (by its real path: macOS's `$TMPDIR` is a link) removed when the file ends. */
export function scratch(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  whenFileEnds(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** The two compilers a type check runs on, as the package names of the workspace's catalog. */
export const COMPILERS: readonly ('typescript' | 'typescript-5.9')[] = [
  'typescript',
  'typescript-5.9',
]

/** The `bin/tsc` of a compiler this package declares (devDependencies): no transitive shim. */
export function compilerBin(compiler: (typeof COMPILERS)[number]): string {
  const bin = join(PACKAGE_DIR, 'node_modules', compiler, 'bin', 'tsc')
  if (!existsSync(bin)) throw new Error(`${compiler} is not installed: ${bin} is missing`)
  return bin
}

/**
 * Links every entry of `from`'s `node_modules` but `except` (and `.bin`) into `to`'s, so a copy
 * resolves the same third-party packages.
 */
export function linkDependencies(from: string, to: string, except: readonly string[] = []): void {
  mkdirSync(join(to, 'node_modules'), { recursive: true })
  for (const name of readdirSync(join(from, 'node_modules'))) {
    if (name === '.bin' || except.includes(name)) continue
    const link = join(to, 'node_modules', name)
    if (existsSync(link)) continue
    symlinkSync(join(from, 'node_modules', name), link, 'dir')
  }
}

/**
 * A copy of the built package in a temp directory removed when the test file ends (by its real
 * path, as a load recorder sees it: macOS's `$TMPDIR` is a link): with the package's own
 * `node_modules` linked (`'all'`), or every dependency but the `@provino/*` workspace links, so
 * no add-on (`'without-add-ons'`, `provino` installed alone).
 */
export function packageCopy(modules: 'all' | 'without-add-ons' = 'all'): string {
  const copy = realpathSync(mkdtempSync(join(tmpdir(), 'provino-copy-')))
  whenFileEnds(() => rmSync(copy, { recursive: true, force: true }))
  copyBuiltPackage(copy)
  if (modules === 'all')
    symlinkSync(join(PACKAGE_DIR, 'node_modules'), join(copy, 'node_modules'), 'dir')
  else linkDependencies(PACKAGE_DIR, copy, ['@provino'])
  return copy
}

/** A native project's config: no dialect, no globals, the TypeScript tests under `tests/`. */
export const NATIVE_CONFIG: string = "export default { include: ['tests/**/*.test.ts'] }\n"

/** `NATIVE_CONFIG` on the `jsdom` environment. */
export const NATIVE_JSDOM_CONFIG: string =
  "export default { include: ['tests/**/*.test.ts'], environment: 'jsdom' }\n"

/**
 * A project with no dialect in a temp directory, removed after the test file: `package.json`
 * (`type: module`), `provino.config.mjs` (`config`), `files` and `node_modules/provino` linked to
 * this package (`linkProvino`).
 */
export async function nativeProject(
  files: Readonly<Record<string, string>>,
  config: string = NATIVE_CONFIG,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'provino-native-'))
  whenFileEnds(() => rm(dir, { recursive: true, force: true }))
  const all: Record<string, string> = {
    'package.json': '{"type":"module"}\n',
    'provino.config.mjs': config,
    ...files,
  }
  for (const [name, text] of Object.entries(all)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), text)
  }
  linkProvino(dir)
  return dir
}

/** `provino run` on a native project's config, one worker of `pool`, normalized JSON to `results.json`. */
export function nativeRunArgs(pool: string): string[] {
  return [
    'run',
    '--config',
    'provino.config.mjs',
    '--pool',
    pool,
    '--maxWorkers',
    '1',
    '--reporter',
    'normalized-json',
    '--outputFile',
    'results.json',
  ]
}

/**
 * Runs `dir` on `pool` through the source bin (`nativeRunArgs`): the exit code and the outcomes of
 * the files named (`a` for `a.test.ts`), by name.
 */
export async function runFiles(
  dir: string,
  pool: string,
  names: readonly string[],
): Promise<{ code: number | null; outcomes: Record<string, string | undefined> }> {
  const ran = await spawnCli(nativeRunArgs(pool), { cwd: dir })
  const found = await outcomesByFile(dir)
  return {
    code: ran.code,
    outcomes: Object.fromEntries(names.map((name) => [name, found.get(`${name}.test.ts`)])),
  }
}
