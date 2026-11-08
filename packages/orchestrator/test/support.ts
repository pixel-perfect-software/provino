// Shared by the end-to-end tests: worker inits, jobs, transports of each kind, and a stream that
// keeps what a worker printed (so a crash's stderr doesn't land in the test output).
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Writable } from 'node:stream'
import { after } from 'node:test'
import type { ResolvedProject } from '@provino/config'
import {
  connectWorker,
  type FileDone,
  fileIdOf,
  relativePosix,
  transportFor,
} from '@provino/orchestrator'
import { moduleRef, neutralPolicy, resolvePolicy, serializePolicy } from '@provino/policy'
import type { RpcHandlers } from '@provino/rpc'
import type {
  CoordinatorMethods,
  EnvironmentRef,
  ExpectTable,
  FileJob,
  GlobalsFactory,
  IsolationTier,
  Policy,
  PolicyOverrides,
  PoolKind,
  SerializedPolicy,
  SerializedProjectConfig,
  TaskId,
  WorkerEvent,
  WorkerExit,
  WorkerInit,
} from '@provino/types'

export const KINDS: readonly PoolKind[] = ['forks', 'threads', 'inline']

export function fixture(name: string): URL {
  return new URL(`./fixtures/${name}`, import.meta.url)
}

/** A valid project config (its refs absolute, as the worker requires); these tests move it around without reading it. */
const config: SerializedProjectConfig = {
  name: 'test',
  rootDir: '/',
  ci: false,
  policy: serializePolicy(neutralPolicy),
  environment: {
    module: fixture('runtime-env.ts').href,
    export: 'recordingEnvironment',
    options: {},
  },
  globals: null,
  setupFiles: [],
  setupFilesAfterEnv: [],
  loader: {
    extensions: ['.ts', '.js'],
    conditions: ['node'],
    tsconfig: false,
    mappers: [],
    typescript: 'oxc',
  },
}

export function initFor(pool: PoolKind, workerId = 1): WorkerInit {
  return {
    key: {
      project: 'test',
      pool,
      environment: 'node',
      environmentOptionsHash: '',
      execArgvHash: '',
      envHash: '',
    },
    workerId,
    isolation: 'registry',
    provided: {},
    config,
  }
}

/** Coordinator methods for tests that never call them. */
export const methods: RpcHandlers<CoordinatorMethods> = {
  resolveSnapshotPath: async (file) => file,
  writeSnapshot: async () => {},
  readTimings: async () => undefined,
}

/** How a worker of `kind` ends when it is force-killed: a fork by SIGKILL, a thread with code 1. */
export function forceKilled(kind: 'forks' | 'threads'): WorkerExit {
  return kind === 'forks'
    ? { type: 'signal', signal: 'SIGKILL', likelyOom: false }
    : { type: 'exit', code: 1 }
}

export function job(file: string): FileJob {
  return { file, fileId: `file:${file}` as TaskId, updateSnapshots: 'none' }
}

/** A writable that keeps everything written to it. */
export class Collect extends Writable {
  text = ''
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.text += chunk.toString()
    done()
  }
}

// ---- The real runtime (U1): a project on disk, a config for it, and a run through `worker/main`.

/** The worker entry every runtime test starts: the real runtime. */
export const RUNTIME_ENTRY: string = import.meta.resolve('@provino/orchestrator/worker/main')

/** A temporary project directory with files in it; `cleanup` removes it. */
export interface Project {
  /** Real path of the directory (so file ids and registry paths agree on every platform). */
  readonly dir: string
  /** The absolute path of `name` in the project. */
  path(name: string): string
  cleanup(): Promise<void>
}

/** Writes `files` (name → text) into a new temporary directory. */
export async function makeProject(files: Readonly<Record<string, string>>): Promise<Project> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'provino-runtime-')))
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), text)
  }
  return {
    dir,
    path: (name) => join(dir, name),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

/**
 * A maker of projects for one test file: each project it makes is removed once the file's tests
 * are done. It registers its own `after`, so call it once, at the top of the file.
 */
export function trackedProjects(): (files: Readonly<Record<string, string>>) => Promise<Project> {
  const made: Project[] = []
  after(async () => {
    await Promise.all(made.map((project) => project.cleanup()))
  })
  return async (files) => {
    const project = await makeProject(files)
    made.push(project)
    return project
  }
}

/** The job for `file` in a project: with the id the coordinator assigns it (D23). */
export function runtimeJob(config: SerializedProjectConfig, file: string): FileJob {
  const path = relativePosix(config.rootDir, file)
  return { file, fileId: fileIdOf(config.name, path), updateSnapshots: 'none' }
}

/**
 * The test policy's layer over the neutral one: the globals injected and an `expect` that builds
 * the fixtures' table. Every behaviour key stays a ref, so it crosses to a thread or a fork.
 */
function runtimePolicyOverrides(): PolicyOverrides {
  return {
    core: { injectGlobals: true },
    expect: {
      matcherTable: moduleRef<() => ExpectTable>(fixture('runtime-table.ts').href, 'testTable'),
      errorShape: 'matcher-result',
      equality: { errors: 'message', invalidDate: 'unequal' },
      soft: false,
      poll: { enabled: false, intervalMs: 50, timeoutMs: 1000 },
      requireAssertions: false,
    },
  }
}

/** The test policy, serialized for a worker's config. */
export function runtimePolicy(): SerializedPolicy {
  return serializePolicy(resolvePolicy(runtimePolicyOverrides()))
}

/**
 * A project config for `rootDir` that loads the fixtures' environment, table and globals by ref.
 * `overrides` replaces whole keys; `environmentOptions` are the options the recording environment
 * gets.
 */
export function runtimeConfig(
  rootDir: string,
  overrides: Partial<SerializedProjectConfig> & {
    readonly environmentOptions?: EnvironmentRef['options']
  } = {},
): SerializedProjectConfig {
  const { environmentOptions, ...replaced } = overrides
  return {
    name: 'rt',
    rootDir,
    ci: false,
    policy: runtimePolicy(),
    environment: {
      module: fixture('runtime-env.ts').href,
      export: 'recordingEnvironment',
      options: environmentOptions ?? {},
    },
    globals: moduleRef<GlobalsFactory>(fixture('runtime-globals.ts').href, 'testGlobals'),
    setupFiles: [],
    setupFilesAfterEnv: [],
    loader: {
      extensions: ['.js', '.ts'],
      conditions: ['node'],
      tsconfig: false,
      mappers: [],
      typescript: 'oxc',
    },
    ...replaced,
  }
}

/** What a run of jobs through one worker produced. */
export interface RuntimeRun {
  readonly events: readonly WorkerEvent[]
  /** One `fileDone` per job, in order. */
  readonly done: readonly FileDone[]
  readonly exit: WorkerExit
}

/**
 * Starts a worker of `pool` on the real entry, runs `jobs` through it one at a time, stops it, and
 * returns every event it sent. `trace` is `globalThis.__trace` for the run: inline workers share
 * this process, so the fixtures write the steps they see into it.
 */
export async function runJobs(options: {
  readonly pool?: PoolKind
  readonly isolation?: IsolationTier
  readonly config: SerializedProjectConfig
  readonly jobs: readonly FileJob[]
  readonly trace?: string[]
  /** How the worker ends: `stop` asks it to (default), `kill` force-terminates it without a `stop`. */
  readonly end?: 'stop' | 'kill'
}): Promise<RuntimeRun> {
  const pool = options.pool ?? 'inline'
  const stderr = new Collect()
  const init: WorkerInit = {
    ...initFor(pool),
    isolation: options.isolation ?? 'registry',
    config: options.config,
  }
  const events: WorkerEvent[] = []
  const done: FileDone[] = []
  const previous = Reflect.get(globalThis, '__trace')
  if (options.trace !== undefined) Reflect.set(globalThis, '__trace', options.trace)
  try {
    const transport = await transportFor(pool, { entry: RUNTIME_ENTRY, stderr }).create(init)
    const connection = connectWorker(transport, {
      methods,
      onEvents: (batch) => void events.push(...batch),
    })
    for (const next of options.jobs) done.push(await connection.run(next))
    await transport.terminate(options.end === 'kill')
    return { events, done, exit: await connection.exited }
  } finally {
    if (options.trace !== undefined) {
      if (previous === undefined) Reflect.deleteProperty(globalThis, '__trace')
      else Reflect.set(globalThis, '__trace', previous)
    }
  }
}

/** The events of one `type`, in order. */
export function eventsOf<Type extends WorkerEvent['type']>(
  events: readonly WorkerEvent[],
  type: Type,
): Extract<WorkerEvent, { readonly type: Type }>[] {
  return events.filter(
    (event): event is Extract<WorkerEvent, { readonly type: Type }> => event.type === type,
  )
}

// ---- The coordinator (`runProject`): a resolved project for the same fixtures.

/** What `runtimeProject` can change. */
export interface RuntimeProjectOptions {
  /** The project name; default `rt`. */
  readonly name?: string
  /** What the recording environment gets (its `leak` option makes every file report leaked globals). */
  readonly environmentOptions?: EnvironmentRef['options']
  /** Test file globs; default every `*.test.js`. */
  readonly include?: readonly string[]
  readonly exclude?: readonly string[]
  /** Layered over the test policy (the `orchestrator` slice's `include`/`exclude` are set from the options above). */
  readonly policy?: PolicyOverrides
}

/**
 * The project a coordinator test runs: the fixtures' environment, table and globals, the test
 * files `include` finds under `rootDir`, and a policy and config that agree. The orchestrator may
 * not depend on `@provino/config`'s callers (the dialects), so this is what `resolveProject`
 * would build for a config that named no dialect.
 */
export function runtimeProject(
  rootDir: string,
  options: RuntimeProjectOptions = {},
): ResolvedProject {
  const include = options.include ?? ['**/*.test.js']
  const exclude = options.exclude ?? ['**/node_modules/**']
  const base = runtimePolicyOverrides()
  const policy: Policy = resolvePolicy({
    ...base,
    ...options.policy,
    core: { ...base.core, ...options.policy?.core },
    expect: { ...base.expect, ...options.policy?.expect },
    orchestrator: { ...options.policy?.orchestrator, include, exclude },
  })
  const name = options.name ?? 'rt'
  return {
    name,
    rootDir,
    dialect: null,
    policy,
    include,
    exclude,
    discovery: null,
    environment: 'recording',
    isolation: 'registry',
    config: runtimeConfig(rootDir, {
      name,
      policy: serializePolicy(policy),
      ...(options.environmentOptions === undefined
        ? {}
        : { environmentOptions: options.environmentOptions }),
    }),
  }
}

/** The worker entry that records the pid of each forked worker: the real runtime otherwise. */
export const PID_RECORDING_ENTRY: URL = fixture('pid-recording-main.ts')

/**
 * The pids of the forked workers that loaded `PID_RECORDING_ENTRY` for this test process, in the
 * order they started, and removes the file. Empty when no worker was started.
 */
export async function takeWorkerPids(): Promise<readonly number[]> {
  const file = join(tmpdir(), `provino-pids-${process.pid}`)
  if (!existsSync(file)) return []
  const pids = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number)
  await rm(file, { force: true })
  return pids
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
