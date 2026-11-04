// T9.2: each transport kind against real workers. 1,000 run/fileDone round trips per kind, the
// `ready` → `start` handshake and its timeout, Track 9's shutdown, and stdio piped with
// `end: false`.
import assert from 'node:assert/strict'
import { ChildProcess } from 'node:child_process'
import { describe, it } from 'node:test'
import { connectWorker, OrchestratorError, type WorkerConnection } from '@provino/orchestrator'
import type { PoolKind, Transport, WorkerExit, WorkerInit } from '@provino/types'
import {
  Collect,
  factoryFor,
  fixture,
  forceKilled,
  initFor,
  job,
  KINDS,
  methods,
} from './support.ts'

async function start(
  kind: PoolKind,
  entry: string,
  options: { readonly teardownTimeoutMs?: number; readonly startTimeoutMs?: number } = {},
): Promise<{ transport: Transport; connection: WorkerConnection; stderr: Collect }> {
  const stderr = new Collect()
  const transport = await factoryFor(kind, { entry: fixture(entry), stderr, ...options }).create(
    initFor(kind),
  )
  return {
    transport,
    connection: connectWorker(transport, { methods, onEvents: () => {} }),
    stderr,
  }
}

for (const kind of KINDS) {
  describe(`${kind} transport`, () => {
    it('round-trips 1,000 run/fileDone pairs', async () => {
      const { transport, connection } = await start(kind, 'echo-worker.ts')
      try {
        for (let i = 0; i < 1000; i++) {
          const done = await connection.run(job(`file-${i}`))
          assert.equal(done.seq, i)
          assert.equal(done.leakedHandles, 0)
          assert.ok(done.memoryBytes > 0)
        }
      } finally {
        await transport.terminate(false)
      }
      assert.deepEqual(await connection.exited, { type: 'exit', code: 0 })
    })

    it('stops gracefully: `stopped` arrives, then exit code 0', async () => {
      const { transport, connection } = await start(kind, 'echo-worker.ts')
      const seen: string[] = []
      transport.onMessage((message) => seen.push(message.t))
      await connection.run(job('a'))
      await transport.terminate(false)
      assert.deepEqual(seen.at(-1), 'stopped')
      assert.deepEqual(await connection.exited, { type: 'exit', code: 0 })
      // A listener added after the exit hears it at once.
      let late: WorkerExit | undefined
      transport.onExit((exit) => {
        late = exit
      })
      assert.deepEqual(late, { type: 'exit', code: 0 })
      await assert.rejects(connection.run(job('b')), { code: 'ORCH_WORKER_EXITED' })
    })

    it('times out a worker that never says ready, and kills it', async () => {
      const stderr = new Collect()
      const error = await factoryFor(kind, {
        entry: fixture('silent-worker.ts'),
        stderr,
        startTimeoutMs: 100,
      })
        .create(initFor(kind))
        .then(
          () => assert.fail('expected the start to time out'),
          (e: unknown) => e,
        )
      assert.ok(error instanceof OrchestratorError)
      assert.equal(error.code, 'ORCH_WORKER_START_TIMEOUT')
      assert.deepEqual(error.cause, { type: 'timeout', phase: 'start' })
    })
  })
}

for (const kind of ['forks', 'threads'] as const) {
  describe(`${kind} transport, killing`, () => {
    it('reports a worker that exits before ready', async () => {
      await assert.rejects(
        factoryFor(kind, { entry: fixture('early-exit-worker.ts') }).create(initFor(kind)),
        (error: unknown) => {
          assert.ok(error instanceof OrchestratorError)
          assert.equal(error.code, 'ORCH_WORKER_EXITED')
          assert.deepEqual(error.cause, { type: 'exit', code: 5 })
          return true
        },
      )
    })

    it('kills a worker that ignores stop after the teardown timeout, as a stop timeout', async () => {
      const { transport, connection } = await start(kind, 'hang-worker.ts', {
        teardownTimeoutMs: 50,
      })
      const running = connection.run(job('forever'))
      await transport.terminate(false)
      const timedOut: WorkerExit = { type: 'timeout', phase: 'stop' }
      assert.deepEqual(await connection.exited, timedOut)
      await assert.rejects(running, (error: unknown) => {
        assert.ok(error instanceof OrchestratorError)
        assert.equal(error.code, 'ORCH_WORKER_EXITED')
        assert.deepEqual(error.cause, timedOut)
        return true
      })
    })

    it('force-kills at once', async () => {
      const { transport, connection } = await start(kind, 'hang-worker.ts')
      void connection.run(job('forever')).catch(() => {})
      await transport.terminate(true)
      assert.deepEqual(await connection.exited, forceKilled(kind))
    })

    it('pipes the worker’s own stdout and stderr without ending the sinks', async () => {
      const stdout = new Collect()
      const stderr = new Collect()
      const transport = await factoryFor(kind, {
        entry: fixture('noisy-worker.ts'),
        stdout,
        stderr,
      }).create(initFor(kind))
      await transport.terminate(false)
      assert.match(stdout.text, /raw stdout before start/)
      assert.match(stderr.text, /raw stderr before start/)
      assert.equal(stdout.writableEnded, false)
      assert.equal(stderr.writableEnded, false)
    })
  })
}

describe('forks transport, escalation', () => {
  it('sends SIGKILL 500 ms after a SIGTERM the worker ignores', async () => {
    const { transport, connection } = await start('forks', 'stubborn-worker.ts', {
      teardownTimeoutMs: 50,
    })
    void connection.run(job('forever')).catch(() => {})
    const signals: string[] = []
    const kill = ChildProcess.prototype.kill
    // Watch which signals the transport sends, without changing what they do.
    ChildProcess.prototype.kill = function (this: ChildProcess, signal?: NodeJS.Signals | number) {
      if (this.pid === transport.pid) signals.push(String(signal))
      return kill.call(this, signal)
    }
    try {
      await transport.terminate(false)
    } finally {
      ChildProcess.prototype.kill = kill
    }
    assert.deepEqual(await connection.exited, { type: 'timeout', phase: 'stop' })
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  })
})

for (const kind of KINDS) {
  describe(`${kind} transport, a bad start`, () => {
    it('refuses an init that can’t cross to the worker, without leaving one running', async () => {
      const init = {
        ...initFor(kind),
        provided: { fn: () => 1 } as unknown as WorkerInit['provided'],
      }
      await assert.rejects(factoryFor(kind, { entry: fixture('echo-worker.ts') }).create(init), {
        code: 'ORCH_BAD_INIT',
      })
    })
  })
}

for (const kind of ['forks', 'threads'] as const) {
  describe(`${kind} transport, output`, () => {
    it('prints an error the entry throws as it loads to the stderr sink', async () => {
      const stderr = new Collect()
      await assert.rejects(
        factoryFor(kind, { entry: fixture('throwing-entry.ts'), stderr }).create(initFor(kind)),
        { code: 'ORCH_WORKER_EXITED' },
      )
      assert.match(stderr.text, /boom from the entry module/)
    })

    it('copies worker output into the sinks without adding listeners to them', async () => {
      const stdout = new Collect()
      const stderr = new Collect()
      const before = stdout.eventNames().length + stderr.eventNames().length
      const transport = await factoryFor(kind, {
        entry: fixture('echo-worker.ts'),
        stdout,
        stderr,
      }).create(initFor(kind))
      assert.equal(stdout.eventNames().length + stderr.eventNames().length, before)
      await transport.terminate(false)
    })
  })
}

describe('inline transport', () => {
  it('refuses an entry without a default-exported function', async () => {
    await assert.rejects(
      factoryFor('inline', { entry: fixture('../support.ts') }).create(initFor('inline')),
      { code: 'ORCH_BAD_ENTRY' },
    )
  })

  it('reports a main that throws as exit code 1, after printing it', async () => {
    const stderr = new Collect()
    await assert.rejects(
      factoryFor('inline', { entry: fixture('throwing-main.ts'), stderr }).create(
        initFor('inline'),
      ),
      (error: unknown) => {
        assert.ok(error instanceof OrchestratorError)
        assert.equal(error.code, 'ORCH_WORKER_EXITED')
        assert.deepEqual(error.cause, { type: 'exit', code: 1 })
        return true
      },
    )
    assert.match(stderr.text, /boom from the main/)
  })

  // The worker has ended once its main has settled and its link has closed. `startWorker` settles
  // after the runner's best-effort `stop`, so a kill is not reported before that teardown is done,
  // and the next inline worker in this process boots after it.
  it('reports a killed worker only after its runner.stop has finished, even one that awaits a macrotask', async () => {
    const steps: string[] = []
    Reflect.set(globalThis, '__steps', steps)
    try {
      for (const workerId of [1, 2]) {
        const transport = await factoryFor('inline', {
          entry: fixture('slow-stop-worker.ts'),
        }).create(initFor('inline', workerId))
        const connection = connectWorker(transport, { methods, onEvents: () => {} })
        // A round trip: the worker's `start` has run once its `fileDone` is back.
        await connection.run(job(`file-${workerId}`))
        await transport.terminate(true)
        assert.deepEqual(await connection.exited, { type: 'exit', code: 0 })
        // The exit is not reported before the stop has ended.
        assert.equal(steps.at(-1), `stopped ${workerId}`)
      }
    } finally {
      Reflect.deleteProperty(globalThis, '__steps')
    }
    assert.deepEqual(steps, ['start 1', 'stop 1', 'stopped 1', 'start 2', 'stop 2', 'stopped 2'])
  })

  it('reports a graceful stop as exit code 0 once the stop has finished', async () => {
    const steps: string[] = []
    Reflect.set(globalThis, '__steps', steps)
    try {
      const transport = await factoryFor('inline', {
        entry: fixture('slow-stop-worker.ts'),
      }).create(initFor('inline'))
      const connection = connectWorker(transport, { methods, onEvents: () => {} })
      await transport.terminate(false)
      assert.deepEqual(await connection.exited, { type: 'exit', code: 0 })
      assert.deepEqual(steps, ['start 1', 'stop 1', 'stopped 1'])
    } finally {
      Reflect.deleteProperty(globalThis, '__steps')
    }
  })

  // A file that can't be cancelled (T5.12) holds the best-effort stop behind it, so the worker's
  // main never settles; the wait for it is bounded by the teardown timeout.
  it('stops waiting for a worker that cannot end after the teardown timeout, and reports it as it is', {
    timeout: 10_000,
  }, async () => {
    const { transport, connection } = await start('inline', 'hang-worker.ts', {
      teardownTimeoutMs: 50,
    })
    void connection.run(job('forever')).catch(() => {})
    await transport.terminate(true)
    assert.deepEqual(await connection.exited, { type: 'exit', code: 0 })
  })
})
