// The runtime runner driven directly, without a transport: what it does around the packer's
// back-pressure and the file's signal, and when it is used out of order. The test plays
// `startWorker`: it builds the contexts and calls `start`, `runFile` and `stop`.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRuntimeRunner, type FileContext, type Packer } from '@provino/orchestrator/worker'
import type { IsolationTier, WorkerEvent } from '@provino/types'
import { initFor, runtimeConfig, runtimeJob, trackedProjects } from './support.ts'

const project = trackedProjects()

/** A packer the test steers: `writable()` stays pending until `open()`. */
function steeredPacker(): Packer & {
  readonly events: WorkerEvent[]
  open(): void
} {
  const events: WorkerEvent[] = []
  const { promise: writable, resolve: open } = Promise.withResolvers<void>()
  return {
    events,
    open: () => open(),
    emit: (event) => void events.push(event),
    ack: () => {},
    afterSent: (callback) => callback(),
    flush: async () => {},
    writable: () => writable,
    inFlight: 0,
  }
}

async function started(
  isolation: IsolationTier = 'registry',
  environmentOptions: Readonly<Record<string, string | number | boolean>> = {},
) {
  const p = await project({
    'a.test.js': "test('a', () => { expect(1).toBe(1) })",
    'b.test.js': "test('b', () => { expect(1).toBe(1) })",
  })
  const config = runtimeConfig(p.dir, { environmentOptions })
  const init = { ...initFor('inline'), isolation, config }
  const sink = steeredPacker()
  const base = {
    init,
    sink,
    console: globalThis.console,
    coordinator: {
      readTimings: async () => undefined,
    },
  }
  const runner = createRuntimeRunner()
  await runner.start?.(base)
  const file = (controller = new AbortController(), name = 'a.test.js'): FileContext => ({
    ...base,
    job: runtimeJob(config, p.path(name)),
    signal: controller.signal,
  })
  return { runner, sink, file, base }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('createRuntimeRunner', () => {
  it('waits for the packer to have room before it starts a file', async () => {
    const { runner, sink, file, base } = await started()
    let finished = false
    const context = file()
    const running = runner.runFile(context).then((outcome) => {
      finished = true
      return outcome
    })
    await settle()
    await settle()
    assert.equal(finished, false)
    assert.equal(sink.events.length, 0, 'nothing runs while the packer is full')

    sink.open()
    // The outcome carries what the file loaded (U5): its own path, here.
    assert.deepEqual(await running, { deps: [context.job.file] })
    assert.ok(sink.events.some((event) => event.type === 'file-end'))
    await runner.stop?.(base)
  })

  it('never starts a file whose signal aborts while it waits', async () => {
    const { runner, sink, file, base } = await started()
    const controller = new AbortController()
    const running = runner.runFile(file(controller))
    await settle()
    controller.abort(new Error('Cancelled: sigint'))
    assert.deepEqual(await running, {})
    sink.open()
    await settle()
    assert.equal(sink.events.length, 0)
    await runner.stop?.(base)
  })

  it('never starts a file whose signal was aborted before it was called', async () => {
    const { runner, sink, file, base } = await started()
    sink.open()
    const controller = new AbortController()
    controller.abort(new Error('Cancelled: bail'))
    assert.deepEqual(await runner.runFile(file(controller)), {})
    assert.equal(sink.events.length, 0)
    await runner.stop?.(base)
  })

  it('refuses a file before it has started, with a code', async () => {
    const { runner, sink, file, base } = await started()
    sink.open()
    await assert.rejects(createRuntimeRunner().runFile(file()), { code: 'ORCH_NOT_STARTED' })
    await runner.stop?.(base)
  })

  describe('the signal the environment’s setup gets', () => {
    /**
     * Starts a runner for `isolation` with `globalThis.__signals` collecting the signal of each
     * environment setup, runs `body`, and stops the runner whatever `body` did.
     */
    async function recordingSignals(
      isolation: IsolationTier,
      body: (
        signals: readonly AbortSignal[],
        use: Awaited<ReturnType<typeof started>>,
      ) => Promise<void>,
    ): Promise<void> {
      const signals: AbortSignal[] = []
      Reflect.set(globalThis, '__signals', signals)
      const use = await started(isolation)
      try {
        use.sink.open()
        await body(signals, use)
      } finally {
        await use.runner.stop?.(use.base)
        Reflect.deleteProperty(globalThis, '__signals')
      }
    }

    it('lives as long as the worker for a worker-scoped environment, not as long as the first file’s run', async () => {
      await recordingSignals('none', async (signals, { runner, file, base }) => {
        const first = new AbortController()
        await runner.runFile(file(first, 'a.test.js'))
        // The first file's run is cancelled (or simply ends and is cleaned up) ...
        first.abort(new Error('Cancelled: bail'))
        // ... and the worker goes on with the next file, in the same environment.
        await runner.runFile(file(new AbortController(), 'b.test.js'))
        assert.equal(signals.length, 1, 'a worker-scoped environment is set up once')
        assert.equal(signals[0]?.aborted, false, 'the first file’s abort did not reach it')
        await runner.stop?.(base)
        assert.equal(signals[0]?.aborted, true, 'stop ends the worker’s lifetime')
      })
    })

    it('is not the first file’s signal', async () => {
      await recordingSignals('none', async (signals, { runner, file }) => {
        const first = new AbortController()
        await runner.runFile(file(first, 'a.test.js'))
        assert.notEqual(signals[0], first.signal)
      })
    })

    it('stays the file’s own signal for a file-scoped environment', async () => {
      await recordingSignals('registry', async (signals, { runner, file }) => {
        const first = new AbortController()
        const second = new AbortController()
        await runner.runFile(file(first, 'a.test.js'))
        await runner.runFile(file(second, 'b.test.js'))
        assert.deepEqual(signals, [first.signal, second.signal])
        first.abort(new Error('Cancelled: bail'))
        assert.deepEqual(
          signals.map((signal) => signal.aborted),
          [true, false],
        )
      })
    })
  })

  describe('globals the environment could not remove (D22)', () => {
    const warnings = (events: readonly WorkerEvent[]) =>
      events.filter((event) => event.type === 'console' && event.level === 'warn')

    it('a file reports them on its outcome and as one warn through the context’s sink, after its events', async () => {
      const { runner, sink, file, base } = await started('registry', { leak: 'a,Symbol(b)' })
      sink.open()
      const context = file()
      assert.deepEqual(await runner.runFile(context), {
        deps: [context.job.file],
        leakedGlobals: ['a', 'Symbol(b)'],
      })
      const kinds = sink.events.map((event) => event.type)
      const [warning] = warnings(sink.events)
      assert.equal(warnings(sink.events).length, 1)
      assert.equal(sink.events.at(-1), warning, 'the last thing the file sent')
      assert.ok(kinds.includes('file-end'))
      assert.ok(warning?.type === 'console' && warning.text.includes(context.job.file))
      await runner.stop?.(base)
    })

    it('a clean file has no leak on its outcome and sends no warning', async () => {
      const { runner, sink, file, base } = await started()
      sink.open()
      const context = file()
      assert.deepEqual(await runner.runFile(context), { deps: [context.job.file] })
      assert.deepEqual(warnings(sink.events), [])
      await runner.stop?.(base)
    })

    it('a worker-scoped environment reports at stop, as one warn through the stop context’s sink', async () => {
      const { runner, sink, file, base } = await started('none', { leak: 'late' })
      sink.open()
      const context = file()
      assert.deepEqual(await runner.runFile(context), { deps: [context.job.file] })
      assert.deepEqual(warnings(sink.events), [], 'nothing while the worker runs')
      await runner.stop?.(base)
      const [warning, ...more] = warnings(sink.events)
      assert.equal(more.length, 0)
      assert.ok(
        warning?.type === 'console' && warning.text.includes('when the worker stopped: late'),
      )
      assert.equal(sink.events.at(-1), warning)
      // A second stop has nothing left to tear down, so it reports nothing again.
      await runner.stop?.(base)
      assert.equal(warnings(sink.events).length, 1)
    })
  })

  it('stops cleanly when it never started, and when stopped twice', async () => {
    const { runner, base } = await started()
    await createRuntimeRunner().stop?.(base)
    await runner.stop?.(base)
    await runner.stop?.(base)
  })
})
