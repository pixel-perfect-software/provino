// `connect()` against a hand-driven spawned worker: the handshake's two failure races.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { neutralPolicy, serializePolicy } from '@provino/policy'
import type {
  CoordinatorToWorker,
  MessageLink,
  SerializedProjectConfig,
  WorkerExit,
  WorkerInit,
  WorkerToCoordinator,
} from '@provino/types'
import { connect, type Spawned } from './shared.ts'

/** A valid project config; these tests move it around without reading it. */
const config: SerializedProjectConfig = {
  name: 't',
  rootDir: '/',
  ci: false,
  seed: 0,
  policy: serializePolicy(neutralPolicy),
  environment: { module: '@provino/env-node', export: 'nodeEnvironment', options: {} },
  globals: null,
  moduleScope: null,
  setupFiles: [],
  setupFilesAfterEnv: [],
  loader: {
    hoist: null,
    moduleScope: [],
    extensions: ['.ts', '.js'],
    conditions: ['node'],
    tsconfig: false,
    mappers: [],
    typescript: 'oxc',
  },
}

const init: WorkerInit = {
  key: {
    project: 't',
    pool: 'forks',
    isolation: 'registry',
    environment: 'node',
    environmentOptionsHash: '',
    execArgvHash: '',
    envHash: '',
  },
  workerId: 1,
  isolation: 'registry',
  provided: {},
  config,
}

/** A spawned worker the test drives: `deliver` hands the transport a message, `exit` ends it. */
function fakeSpawned(
  options: {
    readonly onKill?: (fake: Fake) => void
    readonly send?: (m: CoordinatorToWorker) => void
  } = {},
) {
  const listeners = new Set<(message: WorkerToCoordinator) => void>()
  const kills: string[] = []
  let exitListener: ((exit: WorkerExit) => void) | undefined
  const link: MessageLink<CoordinatorToWorker, WorkerToCoordinator> = {
    send: (message) => options.send?.(message),
    onMessage(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onExit: () => () => {},
    close: () => {},
  }
  const fake = {
    kills,
    deliver: (message: WorkerToCoordinator) => {
      for (const listener of [...listeners]) listener(message)
    },
    exit: (exit: WorkerExit) => exitListener?.(exit),
    spawned: {
      link,
      pid: 1,
      onExit(listener) {
        exitListener = listener
      },
      kill(signal) {
        kills.push(signal)
        options.onKill?.(fake)
      },
    } satisfies Spawned,
  }
  return fake
}
type Fake = ReturnType<typeof fakeSpawned>

describe('connect', () => {
  it('rejects with the start timeout when ready is read only after the timeout fired', async () => {
    const fake = fakeSpawned({
      // The worker's `ready` was already waiting when the timer fired and killed it.
      onKill: (f) => {
        queueMicrotask(() => {
          f.deliver({ t: 'ready' })
          setImmediate(() => f.exit({ type: 'signal', signal: 'SIGKILL', likelyOom: false }))
        })
      },
    })
    await assert.rejects(
      connect('forks', fake.spawned, init, { entry: 'x', startTimeoutMs: 1 }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'ORCH_WORKER_START_TIMEOUT')
        assert.deepEqual((error as Error).cause, { type: 'timeout', phase: 'start', limitMs: 1 })
        return true
      },
    )
    assert.deepEqual(fake.kills, ['SIGKILL'])
  })

  it('kills the worker and rejects when the start message can’t be sent', async () => {
    const fake = fakeSpawned({
      send: (message) => {
        if (message.t === 'start') throw new Error('() => 1 could not be cloned.')
      },
      onKill: (f) =>
        setImmediate(() => f.exit({ type: 'signal', signal: 'SIGKILL', likelyOom: false })),
    })
    const pending = connect('forks', fake.spawned, init, { entry: 'x' })
    fake.deliver({ t: 'ready' })
    await assert.rejects(pending, (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'ORCH_BAD_INIT')
      assert.match((error as Error).message, /could not be cloned/)
      return true
    })
    assert.deepEqual(fake.kills, ['SIGKILL'])
  })

  it('reports a kill for a timeout of the pool as that timeout, once, and keeps the first reason', async () => {
    const fake = fakeSpawned({
      onKill: (f) =>
        setImmediate(() => f.exit({ type: 'signal', signal: 'SIGKILL', likelyOom: false })),
    })
    const pending = connect('forks', fake.spawned, init, { entry: 'x' })
    fake.deliver({ t: 'ready' })
    const transport = await pending
    const exits: WorkerExit[] = []
    transport.onExit((exit) => void exits.push(exit))
    const first = transport.terminate(true, { phase: 'file', limitMs: 25 })
    // A second reason, while the worker is going: the first one stays.
    const second = transport.terminate(true, { phase: 'file', limitMs: 99 })
    await Promise.all([first, second])
    assert.deepEqual(exits, [{ type: 'timeout', phase: 'file', limitMs: 25 }])
  })

  it('reports a kill with no timeout as the signal that ended the worker', async () => {
    const fake = fakeSpawned({
      onKill: (f) =>
        setImmediate(() => f.exit({ type: 'signal', signal: 'SIGKILL', likelyOom: false })),
    })
    const pending = connect('forks', fake.spawned, init, { entry: 'x' })
    fake.deliver({ t: 'ready' })
    const transport = await pending
    const exits: WorkerExit[] = []
    transport.onExit((exit) => void exits.push(exit))
    await transport.terminate(true)
    assert.deepEqual(exits, [{ type: 'signal', signal: 'SIGKILL', likelyOom: false }])
  })
})
