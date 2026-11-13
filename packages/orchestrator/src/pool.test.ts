// The pool over fake transports (no processes): lazy spawn, the worker limit, reuse by key,
// replacement after a leak or a crash, start failures, abort and close.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type {
  CoordinatorToWorker,
  FileJob,
  PoolKind,
  PoolOptions,
  TaskId,
  Transport,
  TransportFactory,
  WorkerEvent,
  WorkerExit,
  WorkerInit,
  WorkerKey,
  WorkerToCoordinator,
} from '@provino/types'
import { OrchestratorError } from './errors.ts'
import { workerKeyOf } from './key.ts'
import {
  createPool,
  defaultMaxWorkers,
  type FileRequest,
  type Pool,
  type PoolDeps,
} from './pool.ts'

/** How a fake worker treats a file, by its name. */
type Plan =
  | 'ok'
  | 'leak'
  | 'crash'
  | 'hang'
  | 'big'
  | 'late-console'
  | 'idle-console'
  // Never finishes by itself; when it is killed, its `fileDone` (already on the way) arrives first.
  | 'done-while-killed'

interface Fake {
  readonly factory: TransportFactory
  /** Worker ids in the order they were started. */
  readonly started: number[]
  /** Workers that have exited, by id. */
  readonly exited: Set<number>
  /** The most files running at once. */
  readonly peak: () => number
  /** Files each worker ran, by worker id. */
  readonly ran: Map<number, string[]>
  /** Ends a worker that `unkillable` kept alive, as the operating system eventually would. */
  readonly end: (workerId: number) => void
}

function fake(
  plan: (file: string) => Plan,
  createFails: (attempt: number, init: WorkerInit) => boolean = () => false,
  extra: {
    /** How long `create` takes; aborting its signal ends it early, as a transport would. */
    readonly createMs?: number
    /** How a worker ends when told to stop. */
    readonly stopExit?: WorkerExit
    /** A worker that never finishes a graceful stop: only a kill ends it. */
    readonly slowStop?: boolean
    /** A worker that no stop and no kill ends: only `Fake.end` does (code stuck in-process). */
    readonly unkillable?: boolean
    /** The transport kind the factory and its workers report. Default: `'inline'`. */
    readonly kind?: PoolKind
    /** The factory's `sharesProcess`: its workers run in this process, so a kill can't end one. */
    readonly sharesProcess?: boolean
  } = {},
): Fake {
  const started: number[] = []
  const exited = new Set<number>()
  const ran = new Map<number, string[]>()
  const enders = new Map<number, () => void>()
  let attempts = 0
  let running = 0
  let peak = 0
  const kind = extra.kind ?? 'inline'
  const factory: TransportFactory = {
    kind,
    ...(extra.sharesProcess === true ? { sharesProcess: true } : {}),
    async create(init: WorkerInit, signal?: AbortSignal): Promise<Transport> {
      attempts++
      if (extra.createMs !== undefined) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, extra.createMs)
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('killed while starting'))
          })
        })
      }
      if (createFails(attempts, init)) throw new Error(`worker ${init.workerId} would not start`)
      started.push(init.workerId)
      const messages: ((message: WorkerToCoordinator) => void)[] = []
      const exits: ((exit: WorkerExit) => void)[] = []
      let exit: WorkerExit | undefined
      let current: string | undefined
      let finishInFlight: (() => void) | undefined
      const finish = (workerExit: WorkerExit): void => {
        if (exit !== undefined) return
        exit = workerExit
        exited.add(init.workerId)
        if (current !== undefined) running--
        for (const listener of exits) listener(workerExit)
      }
      const emit = (message: WorkerToCoordinator): void => {
        for (const listener of messages) listener(message)
      }
      enders.set(init.workerId, () =>
        finish({ type: 'signal', signal: 'SIGKILL', likelyOom: false }),
      )
      const transport: Transport = {
        kind,
        pid: undefined,
        send(message: CoordinatorToWorker) {
          if (message.t === 'stop' && extra.slowStop !== true && extra.unkillable !== true) {
            setImmediate(() => finish(extra.stopExit ?? { type: 'exit', code: 0 }))
          }
          if (message.t !== 'run') return
          const { seq, job } = message
          current = job.file
          running++
          peak = Math.max(peak, running)
          ran.set(init.workerId, [...(ran.get(init.workerId) ?? []), job.file])
          const behaviour = plan(job.file)
          if (behaviour === 'done-while-killed') {
            finishInFlight = () => {
              running--
              current = undefined
              emit({ t: 'fileDone', seq, memoryBytes: 1, leakedHandles: 0, leakedGlobals: [] })
            }
          }
          setImmediate(() => {
            if (behaviour === 'hang' || behaviour === 'done-while-killed') return
            if (behaviour === 'crash') {
              finish({ type: 'signal', signal: 'SIGSEGV', likelyOom: false })
              return
            }
            if (behaviour === 'late-console') {
              emit({ t: 'pack', pack: 0, events: [consoleEvent(job.file)] })
            }
            running--
            current = undefined
            if (behaviour === 'idle-console') {
              setImmediate(() => emit({ t: 'pack', pack: 0, events: [consoleEvent(job.file)] }))
            }
            emit({
              t: 'fileDone',
              seq,
              memoryBytes: behaviour === 'big' ? 10_000 : 1,
              leakedHandles: 0,
              leakedGlobals: behaviour === 'leak' ? ['leaked'] : [],
            })
          })
        },
        onMessage(listener) {
          messages.push(listener)
          return () => {}
        },
        onExit(listener) {
          if (exit !== undefined) listener(exit)
          else exits.push(listener)
          return () => {}
        },
        async terminate(force) {
          if (exit !== undefined) return
          if (extra.unkillable === true) {
            await new Promise<void>((resolve) => exits.push(() => resolve()))
            return
          }
          if (finishInFlight !== undefined) {
            // The worker finished its file just as it was killed: the message arrives, then the exit.
            finishInFlight()
            finishInFlight = undefined
            await new Promise((resolve) => setImmediate(resolve))
            finish({ type: 'signal', signal: 'SIGKILL', likelyOom: false })
          } else if (force) finish({ type: 'signal', signal: 'SIGKILL', likelyOom: false })
          else if (extra.slowStop === true) {
            await new Promise<void>((resolve) => exits.push(() => resolve()))
          } else {
            await new Promise((resolve) => setImmediate(resolve))
            finish(extra.stopExit ?? { type: 'exit', code: 0 })
          }
        },
      }
      return transport
    },
  }
  return { factory, started, exited, peak: () => peak, ran, end: (id) => enders.get(id)?.() }
}

const consoleEvent = (file: string): WorkerEvent => ({
  type: 'console',
  taskId: null,
  stream: 'stdout',
  level: 'log',
  text: file,
  origin: null,
  t: 0,
})

const key = workerKeyOf({
  project: 'p',
  pool: 'inline',
  environment: 'node',
  environmentOptions: {},
  execArgv: [],
})

const otherKey: WorkerKey = { ...key, environment: 'jsdom' }

const options = (
  maxWorkers: number,
  onLeak?: boolean,
  extra: Partial<PoolOptions> = {},
): PoolOptions => ({
  kind: 'inline',
  maxWorkers,
  recycle: onLeak === undefined ? {} : { onLeak },
  teardownTimeoutMs: 1000,
  startTimeoutMs: 1000,
  ...extra,
})

function deps(f: Fake, extra: Partial<PoolDeps> = {}): PoolDeps {
  return {
    transport: (_kind: PoolKind) => f.factory,
    init: (workerKey, workerId): WorkerInit => ({
      key: workerKey,
      workerId,
      isolation: 'registry',
      provided: {},
      config: undefined as never,
    }),
    methods: {
      readTimings: () => undefined,
    },
    ...extra,
  }
}

function request(file: string, extra: Partial<FileRequest> = {}): FileRequest {
  const job: FileJob = { file, fileId: `id:${file}` as TaskId, updateSnapshots: 'none' }
  return { key, job, onEvents: () => {}, ...extra }
}

/** Runs the files and closes the pool, returning each file's outcome. */
async function runAll(pool: Pool, files: readonly string[], workerKey: WorkerKey = key) {
  const outcomes = await Promise.all(
    files.map((file) => pool.run(request(file, { key: workerKey }))),
  )
  await pool.close()
  return outcomes
}

describe('defaultMaxWorkers', () => {
  it('is every core but one, and at least one', async () => {
    const { availableParallelism } = await import('node:os')
    assert.equal(defaultMaxWorkers(), Math.max(1, availableParallelism() - 1))
    assert.ok(defaultMaxWorkers() >= 1)
  })
})

describe('createPool', () => {
  it('starts a worker only when a file is waiting, and no more than the files need', async () => {
    const f = fake(() => 'ok')
    const pool = createPool(options(8), deps(f))
    assert.deepEqual(f.started, [])
    await runAll(pool, ['a'])
    assert.deepEqual(f.started, [1])
  })

  it('never has more than maxWorkers alive, and numbers workers from 1', async () => {
    const f = fake(() => 'ok')
    const pool = createPool(options(2), deps(f))
    const outcomes = await runAll(pool, ['a', 'b', 'c', 'd', 'e', 'f'])
    assert.ok(outcomes.every((o) => o.type === 'done'))
    assert.deepEqual(f.started, [1, 2])
    assert.ok(f.peak() <= 2)
    assert.equal(f.peak(), 2)
  })

  it('runs one file at a time on a worker and reuses an idle worker with the same key', async () => {
    const f = fake(() => 'ok')
    const pool = createPool(options(1), deps(f))
    await runAll(pool, ['a', 'b', 'c'])
    assert.deepEqual(f.started, [1])
    assert.deepEqual(f.ran.get(1), ['a', 'b', 'c'])
  })

  it('serves the files in the order they were requested', async () => {
    const f = fake(() => 'ok')
    const pool = createPool(options(1), deps(f))
    await runAll(pool, ['c', 'a', 'b'])
    assert.deepEqual(f.ran.get(1), ['c', 'a', 'b'])
  })

  it('reports the worker that took each file', async () => {
    const f = fake(() => 'ok')
    const pool = createPool(options(2), deps(f))
    const started: [string, number][] = []
    const files = ['a', 'b', 'c']
    await Promise.all(
      files.map((file) =>
        pool.run(request(file, { onStart: (workerId) => void started.push([file, workerId]) })),
      ),
    )
    await pool.close()
    assert.deepEqual(started, [
      ['a', 1],
      ['b', 2],
      ['c', 1],
    ])
  })

  it('gives a file with another key a worker of its own, stopping an idle one at the limit', async () => {
    const f = fake(() => 'ok')
    const pool = createPool(options(1), deps(f))
    const first = await pool.run(request('a'))
    const second = await pool.run(request('b', { key: otherKey }))
    await pool.close()
    assert.equal(first.type, 'done')
    assert.equal(second.type, 'done')
    assert.deepEqual(f.started, [1, 2])
    assert.deepEqual([...f.exited], [1, 2])
  })

  it('replaces a worker whose file left globals behind (recycle.onLeak)', async () => {
    const f = fake((file) => (file === 'leaky' ? 'leak' : 'ok'))
    const pool = createPool(options(1), deps(f))
    const leaky = await pool.run(request('leaky'))
    const next = await pool.run(request('after'))
    await pool.close()
    assert.equal(leaky.type === 'done' && leaky.workerId, 1)
    assert.equal(next.type === 'done' && next.workerId, 2)
    assert.deepEqual(f.started, [1, 2])
  })

  it('keeps a leaking worker when recycle.onLeak is off', async () => {
    const f = fake(() => 'leak')
    const pool = createPool(options(1, false), deps(f))
    await runAll(pool, ['a', 'b'])
    assert.deepEqual(f.started, [1])
  })

  it('charges a crash to the file that was running, and starts a new worker for the next', async () => {
    const f = fake((file) => (file === 'boom' ? 'crash' : 'ok'))
    const pool = createPool(options(1), deps(f))
    const crashed = await pool.run(request('boom'))
    const next = await pool.run(request('after'))
    await pool.close()
    assert.deepEqual(crashed, {
      type: 'crashed',
      workerId: 1,
      exit: { type: 'signal', signal: 'SIGSEGV', likelyOom: false },
    })
    assert.equal(next.type === 'done' && next.workerId, 2)
  })

  it('lets the other files of a crashed worker run on a replacement', async () => {
    const f = fake((file) => (file === 'boom' ? 'crash' : 'ok'))
    const pool = createPool(options(2), deps(f))
    const outcomes = await runAll(pool, ['a', 'boom', 'b', 'c', 'd'])
    assert.deepEqual(
      outcomes.map((o) => o.type),
      ['done', 'crashed', 'done', 'done', 'done'],
    )
  })

  it('fails the file a worker could not start for, and goes on', async () => {
    const f = fake(
      () => 'ok',
      (attempt) => attempt === 1,
    )
    const pool = createPool(options(1), deps(f))
    const first = await pool.run(request('a'))
    const second = await pool.run(request('b'))
    await pool.close()
    assert.equal(first.type, 'start-failed')
    assert.match(String((first as { error: Error }).error), /would not start/)
    assert.equal(second.type, 'done')
  })

  it('gives up after three failed starts in a row: every file left gets the third error', async () => {
    let attempts = 0
    const f = fake(
      () => 'ok',
      () => {
        attempts++
        return true
      },
    )
    const pool = createPool(options(1), deps(f))
    const outcomes = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((file) => pool.run(request(file))),
    )
    await pool.close()
    assert.equal(attempts, 3)
    assert.ok(outcomes.every((o) => o.type === 'start-failed'))
    const errors = outcomes.map((o) => (o as { error: Error }).error.message)
    assert.deepEqual(errors.slice(2), Array(3).fill(errors[2]))
    // Each outcome names the worker whose failed start its error is: a file’s own, or, for the
    // files left when the pool gave up, the last one.
    assert.deepEqual(
      outcomes.map((o) => (o.type === 'start-failed' ? o.workerId : undefined)),
      [1, 2, 3, 3, 3],
    )
  })

  it('fails only the files whose own start failed while a healthy worker exists: three failures, then a start that works', async () => {
    const f = fake(
      () => 'ok',
      (attempt) => attempt <= 3,
    )
    const pool = createPool(options(4), deps(f))
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const outcomes = await runAll(pool, files)
    assert.deepEqual(
      outcomes.map((o) => o.type),
      ['start-failed', 'start-failed', 'start-failed', 'done', 'done', 'done', 'done', 'done'],
      'the three files the failed spawns were for fail (they are not retried); every other file runs',
    )
    assert.deepEqual(
      outcomes.slice(0, 3).map((o) => (o.type === 'start-failed' ? o.workerId : undefined)),
      [1, 2, 3],
    )
    const ran = [...f.ran.values()].flat().sort()
    assert.deepEqual(ran, ['d', 'e', 'f', 'g', 'h'])
  })

  it('counts start failures per worker key: a project that cannot start does not fail another project', async () => {
    const badKey: WorkerKey = { ...key, project: 'bad' }
    const f = fake(
      () => 'ok',
      (_attempt, init) => init.key.project === 'bad',
    )
    const pool = createPool(options(1), deps(f))
    const outcomes = await Promise.all([
      ...['b1', 'b2', 'b3', 'b4'].map((file) => pool.run(request(file, { key: badKey }))),
      ...['g1', 'g2', 'g3'].map((file) => pool.run(request(file))),
    ])
    await pool.close()
    assert.deepEqual(
      outcomes.map((o) => o.type),
      [...Array(4).fill('start-failed'), ...Array(3).fill('done')],
    )
    assert.deepEqual([...f.ran.values()].flat().sort(), ['g1', 'g2', 'g3'])
  })

  it('does not give up while a worker is alive: files wait for it even after three failed starts in a row', async () => {
    // Worker 1 starts; every later start fails. By the third failure the limit is reached, but
    // worker 1 is busy, so `e` waits for it instead of failing.
    let attempts = 0
    const f = fake(
      () => 'ok',
      (attempt) => {
        attempts = attempt
        return attempt >= 2
      },
    )
    const pool = createPool(options(2), deps(f))
    const outcomes = await runAll(pool, ['a', 'b', 'c', 'd', 'e'])
    assert.deepEqual(
      outcomes.map((o) => o.type),
      ['done', 'start-failed', 'start-failed', 'start-failed', 'done'],
    )
    assert.deepEqual(f.ran.get(1), ['a', 'e'])
    assert.equal(attempts, 4, 'no start was attempted after the limit')
  })

  it('does not give up while a worker is still starting: the last file waits, then gets the error of the start that ended it', async () => {
    const gate = Promise.withResolvers<void>()
    let attempts = 0
    const f = fake(() => 'ok')
    const pool = createPool(
      options(2),
      deps(f, {
        transport: () => ({
          kind: 'inline',
          create: async () => {
            const attempt = ++attempts
            if (attempt === 1) {
              await gate.promise
              throw new Error('the slow start failed too')
            }
            throw new Error(`start ${attempt} failed`)
          },
        }),
      }),
    )
    const outcomes = Promise.all(['a', 'b', 'c', 'd', 'e'].map((file) => pool.run(request(file))))
    // Starts 2, 3 and 4 fail at once; the first, slow one is still starting.
    let settled = false
    void outcomes.then(() => {
      settled = true
    })
    for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(settled, false, 'e waits: a worker is still starting')
    gate.resolve()
    const results = await outcomes
    await pool.close()
    assert.equal(attempts, 4, 'no start was attempted after the limit')
    assert.deepEqual(
      results.map((o) => o.type),
      Array(5).fill('start-failed'),
    )
    const last = results[4]
    assert.ok(last?.type === 'start-failed')
    assert.match(String(last.error), /the slow start failed too/)
    assert.equal(last.workerId, 1)
  })

  it('counts only failures in a row: a worker that starts resets the count', async () => {
    const f = fake(
      // Every file leaks, so each one needs a new worker.
      () => 'leak',
      (attempt) => attempt === 1 || attempt === 2 || attempt === 4 || attempt === 5,
    )
    const pool = createPool(options(1), deps(f))
    const outcomes: string[] = []
    for (const file of ['a', 'b', 'c', 'd', 'e', 'g'])
      outcomes.push((await pool.run(request(file))).type)
    await pool.close()
    assert.deepEqual(outcomes, [
      'start-failed',
      'start-failed',
      'done',
      'start-failed',
      'start-failed',
      'done',
    ])
  })

  it('hands each pack of a file to that file’s onEvents', async () => {
    const f = fake((file) => (file === 'noisy' ? 'late-console' : 'ok'))
    const seen: string[] = []
    const pool = createPool(options(1), deps(f))
    await pool.run(
      request('noisy', { onEvents: (events) => void seen.push(`noisy:${events.length}`) }),
    )
    await pool.run(
      request('quiet', { onEvents: (events) => void seen.push(`quiet:${events.length}`) }),
    )
    await pool.close()
    assert.deepEqual(seen, ['noisy:1'])
  })

  it('hands what a worker sends while it runs no file to onIdleEvents, with its id', async () => {
    const f = fake(() => 'idle-console')
    const idle: [number, number][] = []
    const seen: number[] = []
    const pool = createPool(
      options(1),
      deps(f, { onIdleEvents: (workerId, events) => void idle.push([workerId, events.length]) }),
    )
    await pool.run(request('a', { onEvents: (events) => void seen.push(events.length) }))
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    await pool.close()
    assert.deepEqual(seen, [])
    assert.deepEqual(idle, [[1, 1]])
  })

  it('stops every worker on close and waits for each exit', async () => {
    const f = fake(() => 'ok')
    const pool = createPool(options(3), deps(f))
    await Promise.all(['a', 'b', 'c'].map((file) => pool.run(request(file))))
    assert.equal(f.exited.size, 0)
    await pool.close()
    assert.deepEqual([...f.exited].sort(), [1, 2, 3])
    await pool.close()
  })

  it('aborts: waiting files are not run, a running file’s worker is killed, nothing is left', async () => {
    const f = fake((file) => (file === 'stuck' ? 'hang' : 'ok'))
    const controller = new AbortController()
    const pool = createPool(options(1), deps(f, { signal: controller.signal }))
    const running = pool.run(request('stuck'))
    const waiting = pool.run(request('later'))
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort()
    assert.deepEqual(await running, { type: 'aborted' })
    assert.deepEqual(await waiting, { type: 'aborted' })
    await pool.close()
    assert.deepEqual([...f.exited], [1])
    assert.deepEqual(f.ran.get(1), ['stuck'])
    assert.deepEqual(await pool.run(request('too-late')), { type: 'aborted' })
  })

  it('does not count a worker that was killed while starting, after an abort, as a start failure', async () => {
    const gate = Promise.withResolvers<void>()
    const f = fake(() => 'ok')
    const controller = new AbortController()
    const pool = createPool(
      options(1),
      deps(f, {
        signal: controller.signal,
        transport: () => ({
          kind: 'inline',
          create: async () => {
            await gate.promise
            throw new Error('killed while starting')
          },
        }),
      }),
    )
    const running = pool.run(request('a'))
    controller.abort()
    gate.resolve()
    assert.deepEqual(await running, { type: 'aborted' })
    await pool.close()
  })

  it('kills a worker that is still starting when the signal aborts, without waiting for it', async () => {
    const f = fake(
      () => 'ok',
      () => false,
      { createMs: 5000 },
    )
    const controller = new AbortController()
    const pool = createPool(options(1), deps(f, { signal: controller.signal }))
    const started = performance.now()
    const running = pool.run(request('a'))
    setTimeout(() => controller.abort(), 30)
    assert.deepEqual(await running, { type: 'aborted' })
    await pool.close()
    assert.ok(performance.now() - started < 2000)
  })

  it('reports a worker that ends badly while told to stop, as ORCH_WORKER_EXITED', async () => {
    const stopExit: WorkerExit = { type: 'signal', signal: 'SIGSEGV', likelyOom: false }
    const f = fake(
      () => 'ok',
      () => false,
      { stopExit },
    )
    const errors: unknown[] = []
    const pool = createPool(options(1), deps(f, { onError: (error) => void errors.push(error) }))
    const outcome = await pool.run(request('a'))
    assert.equal(outcome.type, 'done')
    await pool.close()
    assert.equal(errors.length, 1)
    assert.equal((errors[0] as { code?: string }).code, 'ORCH_WORKER_EXITED')
    assert.deepEqual((errors[0] as { cause?: unknown }).cause, stopExit)
  })

  it('reports nothing for a worker that stops cleanly or that the pool killed', async () => {
    const f = fake((file) => (file === 'stuck' ? 'hang' : 'ok'))
    const errors: unknown[] = []
    const controller = new AbortController()
    const pool = createPool(
      options(2),
      deps(f, { signal: controller.signal, onError: (error) => void errors.push(error) }),
    )
    await pool.run(request('a'))
    const stuck = pool.run(request('stuck'))
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort()
    await stuck
    await pool.close()
    assert.deepEqual(errors, [])
  })

  it('starts no worker for a pool that is already aborted', async () => {
    const f = fake(() => 'ok')
    const pool = createPool(options(2), deps(f, { signal: AbortSignal.abort() }))
    assert.deepEqual(await pool.run(request('a')), { type: 'aborted' })
    await pool.close()
    assert.deepEqual(f.started, [])
  })

  it('treats a request that throws from onEvents as the file failing, and replaces the worker', async () => {
    const f = fake((file) => (file === 'noisy' ? 'late-console' : 'ok'))
    const pool = createPool(options(1), deps(f))
    const bad = await pool.run(
      request('noisy', {
        onEvents: () => {
          throw new Error('reporter bug')
        },
      }),
    )
    const next = await pool.run(request('after'))
    await pool.close()
    assert.equal(bad.type, 'failed')
    assert.equal(next.type === 'done' && next.workerId, 2)
  })

  it('tells the error callback a lost worker from any other error', async () => {
    const stopExit: WorkerExit = { type: 'signal', signal: 'SIGSEGV', likelyOom: false }
    const f = fake(
      () => 'idle-console',
      () => false,
      { stopExit },
    )
    const kinds: string[] = []
    const pool = createPool(
      options(1),
      deps(f, {
        onIdleEvents: () => {
          throw new Error('the bus failed')
        },
        onError: (_error, kind) => void kinds.push(kind),
      }),
    )
    await pool.run(request('late'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await pool.close()
    assert.deepEqual(kinds.toSorted(), ['other', 'worker-lost'])
  })

  it('gives the start-failed outcome the exit its error carries', async () => {
    const exit: WorkerExit = { type: 'exit', code: 3 }
    const f = fake(() => 'ok')
    const create = f.factory.create
    let first = true
    const factory: TransportFactory = {
      ...f.factory,
      create: async (init, signal) => {
        if (first) {
          first = false
          throw new OrchestratorError('ORCH_WORKER_EXITED', 'gone before ready', { cause: exit })
        }
        return await create(init, signal)
      },
    }
    const pool = createPool(options(1), deps({ ...f, factory }))
    const [lost, fine] = [await pool.run(request('a')), await pool.run(request('b'))]
    await pool.close()
    assert.ok(lost.type === 'start-failed')
    assert.deepEqual(lost.exit, exit)
    assert.ok(fine.type === 'done')
  })

  it("never starts more workers than the transport's own maxWorkers", async () => {
    const f = fake(() => 'ok')
    const pool = createPool(options(4), deps({ ...f, factory: { ...f.factory, maxWorkers: 1 } }))
    const outcomes = await runAll(pool, ['a', 'b', 'c'])
    assert.ok(outcomes.every((o) => o.type === 'done'))
    assert.deepEqual(f.started, [1])
    assert.equal(f.peak(), 1)
  })

  it('keeps an idle worker until it is drained, then stops it at once, before close', async () => {
    const f = fake(() => 'ok')
    const pool = createPool(options(2), deps(f))
    await pool.run(request('a'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual([...f.exited], [], 'an idle worker waits for a next file')
    pool.drain()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual([...f.exited], [1])
    await pool.close()
  })

  it('stops each worker after its last file once drained, while other files still run', async () => {
    const f = fake((file) => (file === 'slow' ? 'hang' : 'ok'))
    const pool = createPool(options(2), deps(f))
    const slow = pool.run(request('slow'))
    const quick = pool.run(request('b'))
    pool.drain()
    await quick
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual([...f.exited], [2], 'the worker with nothing left to do is gone')
    const closed = pool.close()
    assert.deepEqual(await slow, { type: 'aborted' })
    await closed
  })

  it('runs every waiting file before stopping the workers it drained', async () => {
    const f = fake(() => 'ok')
    const pool = createPool(options(1), deps(f))
    const outcomes = await Promise.all(['a', 'b', 'c'].map((file) => pool.run(request(file))))
    pool.drain()
    await pool.close()
    assert.ok(outcomes.every((o) => o.type === 'done'))
    assert.deepEqual(f.ran.get(1), ['a', 'b', 'c'])
    assert.deepEqual([...f.exited], [1])
  })

  it('refuses a recycle limit or a deadline that makes no sense, with ORCH_BAD_OPTION', () => {
    const f = fake(() => 'ok')
    const bad: readonly Partial<PoolOptions>[] = [
      { recycle: { maxFilesPerWorker: 0 } },
      { recycle: { maxFilesPerWorker: 1.5 } },
      { recycle: { memoryLimitBytes: -1 } },
      { recycle: { memoryLimitBytes: Number.NaN } },
      { fileTimeoutMs: 0 },
      { fileTimeoutMs: Number.POSITIVE_INFINITY },
    ]
    for (const extra of bad) {
      assert.throws(() => createPool({ ...options(1), ...extra }, deps(f)), {
        code: 'ORCH_BAD_OPTION',
      })
    }
    // Infinity switches the memory check off; 0 is "after every file".
    createPool({ ...options(1), recycle: { memoryLimitBytes: Number.POSITIVE_INFINITY } }, deps(f))
    createPool({ ...options(1), recycle: { memoryLimitBytes: 0 } }, deps(f))
  })
})

describe('recycling (T9.5)', () => {
  it('replaces a worker every maxFilesPerWorker files', async () => {
    const f = fake(() => 'ok')
    const pool = createPool(options(1, undefined, { recycle: { maxFilesPerWorker: 3 } }), deps(f))
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const outcomes = await runAll(pool, files)
    assert.ok(outcomes.every((o) => o.type === 'done'))
    assert.deepEqual(
      outcomes.map((o) => o.type === 'done' && o.workerId),
      [1, 1, 1, 2, 2, 2, 3],
      'a fresh worker every 3 files',
    )
    assert.deepEqual(f.ran.get(1), ['a', 'b', 'c'])
    assert.deepEqual(f.ran.get(2), ['d', 'e', 'f'])
    assert.deepEqual([...f.exited].sort(), [1, 2, 3], 'each retired worker has exited')
  })

  it('counts files per worker, not per pool', async () => {
    const f = fake(() => 'ok')
    const pool = createPool(options(2, undefined, { recycle: { maxFilesPerWorker: 2 } }), deps(f))
    const outcomes = await runAll(pool, ['a', 'b', 'c', 'd', 'e', 'f'])
    assert.ok(outcomes.every((o) => o.type === 'done'))
    for (const files of f.ran.values()) assert.ok(files.length <= 2, files.join())
  })

  it('replaces a worker whose file left it over memoryLimitBytes, and keeps one under it', async () => {
    const f = fake((file) => (file.startsWith('big') ? 'big' : 'ok'))
    const pool = createPool(options(1, undefined, { recycle: { memoryLimitBytes: 5000 } }), deps(f))
    const outcomes = await runAll(pool, ['a', 'big-1', 'b', 'c', 'big-2', 'd'])
    assert.deepEqual(
      outcomes.map((o) => o.type === 'done' && o.workerId),
      [1, 1, 2, 2, 2, 3],
      'a worker is replaced after the file that took it over the limit, not before',
    )
    assert.deepEqual(f.ran.get(1), ['a', 'big-1'])
    assert.deepEqual(f.ran.get(2), ['b', 'c', 'big-2'])
  })

  it('replaces the worker after every file when the limit is 0 (Jest: workerIdleMemoryLimit 0)', async () => {
    const f = fake(() => 'ok')
    const pool = createPool(options(1, undefined, { recycle: { memoryLimitBytes: 0 } }), deps(f))
    const outcomes = await runAll(pool, ['a', 'b', 'c'])
    assert.deepEqual(
      outcomes.map((o) => o.type === 'done' && o.workerId),
      [1, 2, 3],
    )
  })

  it('does no memory check when the limit is Infinity, and keeps its worker', async () => {
    const f = fake(() => 'big')
    const pool = createPool(
      options(1, undefined, { recycle: { memoryLimitBytes: Number.POSITIVE_INFINITY } }),
      deps(f),
    )
    await runAll(pool, ['a', 'b', 'c'])
    assert.deepEqual(f.started, [1])
  })
})

describe('the file deadline (T9.5)', () => {
  it('kills the worker of a file that runs past it: crashed, with a file timeout, and goes on', async () => {
    const f = fake((file) => (file === 'stuck' ? 'hang' : 'ok'))
    const pool = createPool(options(1, undefined, { fileTimeoutMs: 40 }), deps(f))
    const started = performance.now()
    const stuck = await pool.run(request('stuck'))
    assert.ok(performance.now() - started >= 35, 'it waited for the deadline')
    assert.deepEqual(stuck, {
      type: 'crashed',
      workerId: 1,
      exit: { type: 'timeout', phase: 'file' },
    })
    const next = await pool.run(request('after'))
    await pool.close()
    assert.equal(next.type === 'done' && next.workerId, 2, 'a replacement serves the next file')
    assert.ok(f.exited.has(1))
  })

  it('keeps the result of a file that finished as the deadline fired, and blames no other file', async () => {
    const f = fake((file) => (file === 'edge' ? 'done-while-killed' : 'ok'))
    const pool = createPool(options(1, undefined, { fileTimeoutMs: 20 }), deps(f))
    const [edge, after] = await Promise.all([pool.run(request('edge')), pool.run(request('after'))])
    await pool.close()
    assert.equal(edge.type, 'done', 'the file that finished keeps its result')
    assert.equal(edge.type === 'done' && edge.workerId, 1)
    assert.deepEqual(f.ran.get(1), ['edge'], 'the dying worker was given no second file')
    assert.equal(after.type, 'done', 'the next file is not charged with the deadline')
    assert.equal(after.type === 'done' && after.workerId, 2, 'a replacement ran it')
  })

  it('does not fire for a file that ends in time, and does not leave a timer behind', async () => {
    const f = fake(() => 'ok')
    const pool = createPool(options(1, undefined, { fileTimeoutMs: 50 }), deps(f))
    const outcomes = await runAll(pool, ['a', 'b', 'c'])
    assert.ok(outcomes.every((o) => o.type === 'done'))
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.deepEqual(f.started, [1], 'no worker was killed after its file ended')
  })

  it('counts from when the job is sent, so a slow onStart does not eat the deadline', async () => {
    const f = fake(() => 'ok')
    const pool = createPool(options(1, undefined, { fileTimeoutMs: 40 }), deps(f))
    const outcome = await pool.run(
      request('a', { onStart: () => new Promise((resolve) => setTimeout(resolve, 80)) }),
    )
    await pool.close()
    assert.equal(outcome.type, 'done')
  })

  it('is not a timeout for a file the run aborted', async () => {
    const f = fake((file) => (file === 'stuck' ? 'hang' : 'ok'))
    const controller = new AbortController()
    const pool = createPool(
      options(1, undefined, { fileTimeoutMs: 5000 }),
      deps(f, { signal: controller.signal }),
    )
    const stuck = pool.run(request('stuck'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    assert.deepEqual(await stuck, { type: 'aborted' })
    await pool.close()
  })
})

describe('cancelling and forcing', () => {
  it('cancelQueued gives up the waiting files and lets the running one finish', async () => {
    const f = fake((file) => (file === 'slow' ? 'hang' : 'ok'))
    const pool = createPool(options(1), deps(f))
    const slow = pool.run(request('slow'))
    const waiting = [pool.run(request('b')), pool.run(request('c'))]
    await new Promise((resolve) => setTimeout(resolve, 10))
    pool.cancelQueued()
    assert.deepEqual(await Promise.all(waiting), [{ type: 'aborted' }, { type: 'aborted' }])
    assert.deepEqual(await pool.run(request('d')), { type: 'aborted' }, 'nothing starts after it')
    assert.deepEqual(f.ran.get(1), ['slow'], 'the running file was not touched')
    assert.equal(f.exited.size, 0, 'and neither was its worker')
    const closed = pool.close()
    assert.deepEqual(await slow, { type: 'aborted' })
    await closed
  })

  it('a force signal kills every worker at once, even one that is stopping slowly', async () => {
    // Workers whose graceful stop never ends: only a kill does.
    const f = fake(() => 'ok', undefined, { slowStop: true })
    const force = new AbortController()
    const pool = createPool(options(2), deps(f, { forceSignal: force.signal }))
    await Promise.all([pool.run(request('a')), pool.run(request('b'))])
    pool.drain()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(f.exited.size, 0, 'the graceful stops are hanging')
    const closing = pool.close()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(f.exited.size, 0, 'and close is waiting for them')
    force.abort()
    await closing
    assert.deepEqual([...f.exited].sort(), [1, 2], 'the force kill ended both at once')
  })

  it('a force signal gives up on a file an inline worker is stuck in, and does not wait for it to wind down', {
    timeout: 10_000,
  }, async () => {
    // A worker no stop and no kill ends: what a file that can't be cancelled does to the process
    // that is running it. Only the force signal is allowed to stop waiting for it.
    const f = fake(() => 'hang', undefined, { unkillable: true, sharesProcess: true })
    const abort = new AbortController()
    const force = new AbortController()
    const pool = createPool(
      options(1),
      deps(f, { signal: abort.signal, forceSignal: force.signal }),
    )
    const running = pool.run(request('stuck'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    abort.abort()
    const closing = pool.close()
    let settled = false
    void Promise.all([running, closing]).then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(settled, false, 'the first abort still waits for the worker')
    force.abort()
    assert.deepEqual(await running, { type: 'aborted' })
    await closing
    assert.equal(f.exited.size, 0, 'the worker is still there: nothing could end it')
  })

  it('a force signal still waits for the exit of a worker that does not share the process', async () => {
    const f = fake(() => 'hang', undefined, { unkillable: true, kind: 'forks' })
    const force = new AbortController()
    const pool = createPool(options(1), deps(f, { forceSignal: force.signal }))
    const running = pool.run(request('stuck'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    const closing = pool.close()
    force.abort()
    let settled = false
    void Promise.all([running, closing]).then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(settled, false, 'a child that is still alive is waited for')
    f.end(1)
    await closing
    assert.deepEqual(await running, { type: 'aborted' })
  })

  it('a force signal already aborted starts no worker', async () => {
    const f = fake(() => 'ok')
    const force = new AbortController()
    force.abort()
    const pool = createPool(options(1), deps(f, { forceSignal: force.signal }))
    assert.deepEqual(await pool.run(request('a')), { type: 'aborted' })
    await pool.close()
    assert.deepEqual(f.started, [])
  })
})
