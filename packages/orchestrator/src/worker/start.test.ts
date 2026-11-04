// `startWorker` over a raw MessageChannel, with the test as the coordinator: what a worker owes the
// coordinator when a runner misbehaves, output arrives late, a cancel comes early, or the
// coordinator goes away. Inline pool, so nothing global is patched.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MessageChannel } from 'node:worker_threads'
import { neutralPolicy, serializePolicy } from '@provino/policy'
import { createRpc, messagePortLink } from '@provino/rpc'
import type {
  CoordinatorMethods,
  CoordinatorToWorker,
  FileJob,
  RuntimeEventOf,
  SerializedProjectConfig,
  TaskId,
  WorkerEvent,
  WorkerInit,
  WorkerMethods,
  WorkerPort,
  WorkerToCoordinator,
} from '@provino/types'
import { type StartWorkerOptions, startWorker, type WorkerRunner } from './start.ts'

/** A valid project config; these tests move it around without reading it. */
const config: SerializedProjectConfig = {
  name: 't',
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

const init: WorkerInit = {
  key: {
    project: 't',
    pool: 'inline',
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
const job = (file: string): FileJob => ({
  file,
  fileId: `file:${file}` as TaskId,
  updateSnapshots: 'none',
})
const note = (job: FileJob, message: string): WorkerEvent => ({
  type: 'annotation',
  testId: job.fileId,
  message,
  kind: 'note',
  location: null,
  t: 0,
})

/** The test plays the coordinator: it records every message and acks every pack. */
function harness(runner: WorkerRunner, options: StartWorkerOptions = {}) {
  const { port1, port2 } = new MessageChannel()
  const coordinator = messagePortLink<CoordinatorToWorker, WorkerToCoordinator>(port1)
  const workerPort: WorkerPort = messagePortLink(port2)
  const received: WorkerToCoordinator[] = []
  let wake: () => void = () => {}
  coordinator.onMessage((message) => {
    received.push(message)
    if (message.t === 'pack') coordinator.send({ t: 'ack', pack: message.pack })
    wake()
  })
  const done = startWorker(workerPort, runner, options)
  // A round trip to the worker: once it is answered, every message sent before it was handled.
  const worker = createRpc<CoordinatorMethods, WorkerMethods>(coordinator, {
    resolveSnapshotPath: async (file) => file,
    writeSnapshot: async () => {},
    readTimings: async () => undefined,
  })
  const barrier = async (): Promise<void> => {
    await worker.memoryUsage()
  }
  const until = async (match: (message: WorkerToCoordinator) => boolean): Promise<void> => {
    while (!received.some(match)) await new Promise<void>((resolve) => (wake = resolve))
  }
  const events = (): WorkerEvent[] =>
    received.flatMap((message) => (message.t === 'pack' ? message.events : []))
  const fileDone = (seq: number) => (message: WorkerToCoordinator) =>
    message.t === 'fileDone' && message.seq === seq
  return { coordinator, received, done, until, events, fileDone, barrier }
}

describe('startWorker', () => {
  it('still sends fileDone when the thrown value breaks plain serialization', async (t) => {
    const getterError = new Error('x')
    Object.defineProperty(getterError, 'message', {
      get() {
        throw new Error('no message for you')
      },
    })
    const thrown: Record<string, unknown> = {
      'null-prototype': Object.create(null),
      getter: getterError,
    }
    const h = harness({
      runFile: async ({ job }) => {
        throw thrown[job.file]
      },
    })
    t.after(() => h.coordinator.close())
    h.coordinator.send({ t: 'start', init })
    h.coordinator.send({ t: 'run', seq: 0, job: job('null-prototype') })
    h.coordinator.send({ t: 'run', seq: 1, job: job('getter') })
    await h.until(h.fileDone(1))
    const charged = h
      .events()
      .filter((e): e is RuntimeEventOf<'unhandled-error'> => e.type === 'unhandled-error')
    assert.deepEqual(
      charged.map((e) => e.ownerId),
      ['file:null-prototype', 'file:getter'],
    )
  })

  it('sends output emitted just after runFile returns before fileDone', async (t) => {
    const h = harness({
      runFile: async ({ job, sink }) => {
        sink.emit(note(job, 'during'))
        // A floating chain, as a test's un-awaited promise leaves behind.
        let chain = Promise.resolve()
        for (let i = 0; i < 5; i++) chain = chain.then(() => {})
        void chain.then(() => sink.emit(note(job, 'late')))
        return undefined
      },
    })
    t.after(() => h.coordinator.close())
    h.coordinator.send({ t: 'start', init })
    h.coordinator.send({ t: 'run', seq: 0, job: job('a') })
    await h.until(h.fileDone(0))
    const done = h.received.findIndex(h.fileDone(0))
    const before = h.received
      .slice(0, done)
      .flatMap((m) => (m.t === 'pack' ? m.events : []))
      .map((e) => (e as RuntimeEventOf<'annotation'>).message)
    assert.deepEqual(before, ['during', 'late'])
  })

  it('aborts a file that a cancel reached while it was still queued, but not later ones', async (t) => {
    const starting = Promise.withResolvers<void>()
    const aborted: string[] = []
    const h = harness({
      start: () => starting.promise,
      runFile: async ({ job, signal }) => {
        aborted.push(`${job.file}:${signal.aborted}`)
        return undefined
      },
    })
    t.after(() => h.coordinator.close())
    h.coordinator.send({ t: 'start', init })
    h.coordinator.send({ t: 'run', seq: 0, job: job('queued') })
    h.coordinator.send({ t: 'cancel', reason: 'bail' })
    h.coordinator.send({ t: 'run', seq: 1, job: job('after') })
    await h.barrier()
    starting.resolve()
    await h.until(h.fileDone(1))
    assert.deepEqual(aborted, ['queued:true', 'after:false'])
  })

  it('never starts files still queued when the coordinator goes away', async (t) => {
    const first = Promise.withResolvers<void>()
    const running = Promise.withResolvers<void>()
    const gone = Promise.withResolvers<void>()
    const started: string[] = []
    const h = harness({
      runFile: async ({ job, signal }) => {
        started.push(job.file)
        signal.addEventListener('abort', () => gone.resolve(), { once: true })
        running.resolve()
        await first.promise
        return undefined
      },
    })
    t.after(() => h.coordinator.close())
    h.coordinator.send({ t: 'start', init })
    h.coordinator.send({ t: 'run', seq: 0, job: job('a') })
    h.coordinator.send({ t: 'run', seq: 1, job: job('b') })
    await running.promise
    await h.barrier()
    h.coordinator.close()
    // The worker has heard of it (it aborts the running file's signal) before file a ends.
    await gone.promise
    first.resolve()
    await h.done
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(started, ['a'])
  })

  it('gives each file a fresh console: no open group or count carries over', async (t) => {
    const h = harness({
      runFile: async ({ job, console }) => {
        if (job.file === 'one') {
          console.group('suite')
          console.count('hits')
        } else {
          console.log('two')
          console.count('hits')
        }
        return undefined
      },
    })
    t.after(() => h.coordinator.close())
    h.coordinator.send({ t: 'start', init })
    h.coordinator.send({ t: 'run', seq: 0, job: job('one') })
    h.coordinator.send({ t: 'run', seq: 1, job: job('two') })
    await h.until(h.fileDone(1))
    const texts = h
      .events()
      .filter((e): e is RuntimeEventOf<'console'> => e.type === 'console')
      .map((e) => e.text)
    assert.deepEqual(texts, ['suite\n', '  hits: 1\n', 'two\n', 'hits: 1\n'])
  })

  describe('fileDone.leakedGlobals', () => {
    it('carries the keys the runner reports for the file, and is empty for a clean one', async (t) => {
      const h = harness({
        runFile: async ({ job }) => (job.file === 'leaky' ? { leakedGlobals: ['a', 'b'] } : {}),
      })
      t.after(() => h.coordinator.close())
      h.coordinator.send({ t: 'start', init })
      h.coordinator.send({ t: 'run', seq: 0, job: job('leaky') })
      h.coordinator.send({ t: 'run', seq: 1, job: job('clean') })
      h.coordinator.send({ t: 'run', seq: 2, job: job('nothing') })
      await h.until(h.fileDone(2))
      const dones = h.received.filter((m) => m.t === 'fileDone')
      assert.deepEqual(
        dones.map((m) => m.t === 'fileDone' && m.leakedGlobals),
        [['a', 'b'], [], []],
      )
    })

    it('is empty for a file whose runner threw: the file is charged, and the field is still there', async (t) => {
      const h = harness({
        runFile: async () => {
          throw new Error('boom')
        },
      })
      t.after(() => h.coordinator.close())
      h.coordinator.send({ t: 'start', init })
      h.coordinator.send({ t: 'run', seq: 0, job: job('a') })
      await h.until(h.fileDone(0))
      const done = h.received.find(h.fileDone(0))
      assert.deepEqual(done?.t === 'fileDone' && done.leakedGlobals, [])
    })
  })

  describe('a link that goes away before any stop', () => {
    /** A runner that counts its `stop` calls and says when one starts and finishes. */
    function counting(behaviour: () => void | Promise<void> = () => {}) {
      const calls: string[] = []
      const called = Promise.withResolvers<void>()
      const runner: WorkerRunner = {
        runFile: async ({ job }) => {
          calls.push(`run ${job.file}`)
          return undefined
        },
        stop: async () => {
          calls.push('stop')
          called.resolve()
          await behaviour()
        },
      }
      return { runner, calls, called: called.promise }
    }

    it('still calls runner.stop, once, so what the worker installed does not outlive it', {
      timeout: 10_000,
    }, async () => {
      const { runner, calls, called } = counting()
      const h = harness(runner)
      h.coordinator.send({ t: 'start', init })
      h.coordinator.send({ t: 'run', seq: 0, job: job('a') })
      await h.until(h.fileDone(0))
      h.coordinator.close()
      await h.done
      await called
      assert.deepEqual(calls, ['run a', 'stop'])
    })

    it('drops what the best-effort stop throws, and the worker still ends', {
      timeout: 10_000,
    }, async () => {
      const { runner, calls, called } = counting(() => {
        throw new Error('nowhere to report this')
      })
      const h = harness(runner)
      h.coordinator.send({ t: 'start', init })
      await h.barrier()
      h.coordinator.close()
      await h.done
      await called
      // Let the failed stop settle: an unreported rejection would fail this test.
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.deepEqual(calls, ['stop'])
    })

    it('aborts the running file at once, but stops only after it, and done waits for the stop', {
      timeout: 10_000,
    }, async () => {
      const gate = Promise.withResolvers<void>()
      const started = Promise.withResolvers<void>()
      const aborted = Promise.withResolvers<void>()
      const calls: string[] = []
      const h = harness({
        runFile: async ({ signal }) => {
          signal.addEventListener('abort', () => aborted.resolve(), { once: true })
          started.resolve()
          await gate.promise
          calls.push('file ended')
          return undefined
        },
        stop: () => {
          calls.push('stop')
        },
      })
      let doneSettled = false
      void h.done.then(() => {
        doneSettled = true
      })
      h.coordinator.send({ t: 'start', init })
      h.coordinator.send({ t: 'run', seq: 0, job: job('a') })
      await started.promise
      h.coordinator.close()
      // The worker heard of it, and aborted the file's signal, while the file is still running.
      await aborted.promise
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.deepEqual(calls, [], 'cancel does not reach a running file yet, so stop waits for it')
      assert.equal(doneSettled, false, 'the worker has not ended: its stop has not run')
      gate.resolve()
      await h.done
      assert.deepEqual(calls, ['file ended', 'stop'])
    })

    it('resolves done only after a stop that awaits a macrotask has settled', {
      timeout: 10_000,
    }, async () => {
      const calls: string[] = []
      const h = harness({
        runFile: async () => undefined,
        stop: async () => {
          calls.push('stop')
          await new Promise<void>((resolve) => setImmediate(resolve))
          calls.push('stop settled')
        },
      })
      h.coordinator.send({ t: 'start', init })
      await h.barrier()
      h.coordinator.close()
      await h.done
      assert.deepEqual(calls, ['stop', 'stop settled'])
    })

    it('restores the patched console at once, before the stop it queued has run', {
      timeout: 10_000,
    }, async () => {
      const gate = Promise.withResolvers<void>()
      const started = Promise.withResolvers<void>()
      const original = (): boolean => true
      const stream = { write: original }
      const calls: string[] = []
      const h = harness(
        {
          runFile: async () => {
            started.resolve()
            await gate.promise
            return undefined
          },
          stop: () => {
            calls.push('stop')
          },
        },
        { console: { streams: { stdout: stream, stderr: { write: original } } } },
      )
      h.coordinator.send({ t: 'start', init })
      h.coordinator.send({ t: 'run', seq: 0, job: job('a') })
      await started.promise
      assert.notEqual(stream.write, original, 'the stream is patched while the worker runs')
      h.coordinator.close()
      while (stream.write !== original) await new Promise<void>((resolve) => setImmediate(resolve))
      assert.deepEqual(calls, [], 'the stop is still queued behind the file')
      gate.resolve()
      await h.done
      assert.deepEqual(calls, ['stop'])
    })

    it('does not call stop twice when a stop came first, and not for a worker that never started', async () => {
      const first = counting()
      const h = harness(first.runner)
      h.coordinator.send({ t: 'start', init })
      h.coordinator.send({ t: 'stop' })
      await h.until((message) => message.t === 'stopped')
      await h.done
      h.coordinator.close()
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.deepEqual(first.calls, ['stop'])

      const never = counting()
      const idle = harness(never.runner)
      idle.coordinator.close()
      await idle.done
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.deepEqual(never.calls, [])
    })
  })

  describe('stop', () => {
    const stopped = (message: WorkerToCoordinator): boolean => message.t === 'stopped'

    it('calls runner.stop after the queued files and before stopped, and what it emits arrives first', async (t) => {
      const steps: string[] = []
      let seen: WorkerInit | undefined
      const h = harness({
        runFile: async ({ job }) => {
          steps.push(`run ${job.file}`)
          return undefined
        },
        stop: ({ init, sink }) => {
          seen = init
          steps.push('stop')
          sink.emit(note(job('a'), 'from stop'))
        },
      })
      t.after(() => h.coordinator.close())
      h.coordinator.send({ t: 'start', init })
      h.coordinator.send({ t: 'run', seq: 0, job: job('a') })
      h.coordinator.send({ t: 'run', seq: 1, job: job('b') })
      h.coordinator.send({ t: 'stop' })
      await h.until(stopped)
      await h.done
      assert.deepEqual(steps, ['run a', 'run b', 'stop'])
      assert.equal(seen?.workerId, init.workerId, 'stop gets the worker’s context')
      const at = (match: (m: WorkerToCoordinator) => boolean): number => h.received.findIndex(match)
      const stoppedAt = at(stopped)
      assert.ok(at(h.fileDone(1)) < stoppedAt, 'both files finished first')
      const emitted = h.received.findIndex(
        (m) =>
          m.t === 'pack' &&
          m.events.some((e) => e.type === 'annotation' && e.message === 'from stop'),
      )
      assert.ok(emitted !== -1 && emitted < stoppedAt, 'what stop emitted was sent before stopped')
    })

    it('awaits an async stop before sending stopped', async (t) => {
      const gate = Promise.withResolvers<void>()
      const reached = Promise.withResolvers<void>()
      const h = harness({
        runFile: async () => undefined,
        stop: async () => {
          reached.resolve()
          await gate.promise
        },
      })
      t.after(() => h.coordinator.close())
      h.coordinator.send({ t: 'start', init })
      h.coordinator.send({ t: 'stop' })
      await reached.promise
      await h.barrier()
      assert.equal(h.received.some(stopped), false, 'stopped waits for stop')
      gate.resolve()
      await h.until(stopped)
      await h.done
    })

    it('reports a throwing stop as an unhandled error with no owner, and still sends stopped', async (t) => {
      const h = harness({
        runFile: async () => undefined,
        stop: () => {
          throw new Error('teardown failed')
        },
      })
      t.after(() => h.coordinator.close())
      h.coordinator.send({ t: 'start', init })
      h.coordinator.send({ t: 'stop' })
      await h.until(stopped)
      await h.done
      const unhandled = h
        .events()
        .filter((e): e is RuntimeEventOf<'unhandled-error'> => e.type === 'unhandled-error')
      assert.deepEqual(
        unhandled.map((e) => [e.ownerId, e.error.message]),
        [[null, 'teardown failed']],
      )
      const reportedAt = h.received.findIndex(
        (m) => m.t === 'pack' && m.events.some((e) => e.type === 'unhandled-error'),
      )
      assert.ok(reportedAt < h.received.findIndex(stopped), 'reported before stopped')
    })

    it('still calls stop when start threw, so a half-built worker is torn down', async (t) => {
      const steps: string[] = []
      const h = harness({
        start: () => {
          throw new Error('start failed')
        },
        runFile: async () => undefined,
        stop: () => {
          steps.push('stop')
        },
      })
      t.after(() => h.coordinator.close())
      h.coordinator.send({ t: 'start', init })
      h.coordinator.send({ t: 'stop' })
      await h.until(stopped)
      await h.done
      assert.deepEqual(steps, ['stop'])
    })

    it('does not call stop for a worker that never started, and works without a stop', async (t) => {
      const steps: string[] = []
      const never = harness({
        runFile: async () => undefined,
        stop: () => {
          steps.push('stop')
        },
      })
      t.after(() => never.coordinator.close())
      never.coordinator.send({ t: 'stop' })
      await never.until(stopped)
      await never.done
      assert.deepEqual(steps, [])

      const plain = harness({ runFile: async () => undefined })
      t.after(() => plain.coordinator.close())
      plain.coordinator.send({ t: 'start', init })
      plain.coordinator.send({ t: 'stop' })
      await plain.until(stopped)
      await plain.done
    })
  })
})
