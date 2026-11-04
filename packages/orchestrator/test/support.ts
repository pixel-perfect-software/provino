// Shared by the end-to-end tests: worker inits, jobs, transports of each kind, and a stream that
// keeps what a worker printed (so a crash's stderr doesn't land in the test output).
import { Writable } from 'node:stream'
import {
  forksTransport,
  inlineTransport,
  type TransportOptions,
  threadsTransport,
} from '@provino/orchestrator'
import { neutralPolicy, serializePolicy } from '@provino/policy'
import type { RpcHandlers } from '@provino/rpc'
import type {
  CoordinatorMethods,
  FileJob,
  PoolKind,
  SerializedProjectConfig,
  TaskId,
  TransportFactory,
  WorkerExit,
  WorkerInit,
} from '@provino/types'

export const KINDS: readonly PoolKind[] = ['forks', 'threads', 'inline']

export function fixture(name: string): URL {
  return new URL(`./fixtures/${name}`, import.meta.url)
}

/** A valid project config; these tests move it around without reading it. */
const config: SerializedProjectConfig = {
  name: 'test',
  rootDir: '/',
  ci: false,
  policy: serializePolicy(neutralPolicy),
  environment: { module: '@provino/env-node', export: 'nodeEnvironment', options: {} },
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
