// Shared by the end-to-end tests: worker inits, jobs, transports of each kind, and a stream that
// keeps what a worker printed (so a crash's stderr doesn't land in the test output).
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { Writable } from 'node:stream'
import { after } from 'node:test'
import {
  connectWorker,
  type FileDone,
  forksTransport,
  inlineTransport,
  type TransportOptions,
  threadsTransport,
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
  PoolKind,
  SerializedPolicy,
  SerializedProjectConfig,
  TaskId,
  TransportFactory,
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

export function factoryFor(
  pool: PoolKind,
  options: TransportOptions & {
    readonly memoryLimitMb?: number
    readonly execArgv?: readonly string[]
  },
): TransportFactory {
  switch (pool) {
    case 'forks':
      return forksTransport(options)
    case 'threads':
      return threadsTransport(options)
    case 'inline':
      return inlineTransport(options)
    default:
      return pool satisfies never
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

/** The id core gives a file: the project name and the POSIX path relative to the root, hashed. */
export function fileIdOf(projectName: string, rootDir: string, file: string): TaskId {
  const path = relative(rootDir, file).split(sep).join('/')
  return createHash('sha1').update(`${projectName}\0${path}`).digest('hex').slice(0, 10) as TaskId
}

/** The job for `file` in a project: with the id core will give its events. */
export function runtimeJob(config: SerializedProjectConfig, file: string): FileJob {
  return { file, fileId: fileIdOf(config.name, config.rootDir, file), updateSnapshots: 'none' }
}

/**
 * The test policy: the neutral one with the globals injected and an `expect` that builds the
 * fixtures' table. Every behaviour key stays a ref, so it crosses to a thread or a fork.
 */
export function runtimePolicy(): SerializedPolicy {
  return serializePolicy(
    resolvePolicy({
      core: { injectGlobals: true },
      expect: {
        matcherTable: moduleRef<() => ExpectTable>(fixture('runtime-table.ts').href, 'testTable'),
        errorShape: 'matcher-result',
        equality: { errors: 'message', invalidDate: 'unequal' },
        soft: false,
        poll: { enabled: false, intervalMs: 50, timeoutMs: 1000 },
        requireAssertions: false,
      },
    }),
  )
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
    const transport = await factoryFor(pool, { entry: RUNTIME_ENTRY, stderr }).create(init)
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
