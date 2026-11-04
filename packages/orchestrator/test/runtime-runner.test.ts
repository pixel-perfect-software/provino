// The runtime runner driven directly, without a transport: what it does around the packer's
// back-pressure and the file's signal, and when it is used out of order. The test plays
// `startWorker`: it builds the contexts and calls `start`, `runFile` and `stop`.
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { createRuntimeRunner, type FileContext, type Packer } from '@provino/orchestrator/worker'
import type { WorkerEvent } from '@provino/types'
import { initFor, makeProject, type Project, runtimeConfig, runtimeJob } from './support.ts'

const projects: Project[] = []
after(async () => {
  await Promise.all(projects.map((made) => made.cleanup()))
})

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

async function started() {
  const p = await makeProject({ 'a.test.js': "test('a', () => { expect(1).toBe(1) })" })
  projects.push(p)
  const config = runtimeConfig(p.dir)
  const init = { ...initFor('inline'), config }
  const sink = steeredPacker()
  const base = {
    init,
    sink,
    console: globalThis.console,
    coordinator: {
      resolveSnapshotPath: async (file: string) => file,
      writeSnapshot: async () => {},
      readTimings: async () => undefined,
    },
  }
  const runner = createRuntimeRunner()
  await runner.start?.(base)
  const file = (controller = new AbortController()): FileContext => ({
    ...base,
    job: runtimeJob(config, p.path('a.test.js')),
    signal: controller.signal,
  })
  return { runner, sink, file, base }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('createRuntimeRunner', () => {
  it('waits for the packer to have room before it starts a file', async () => {
    const { runner, sink, file, base } = await started()
    let finished = false
    const running = runner.runFile(file()).then((outcome) => {
      finished = true
      return outcome
    })
    await settle()
    await settle()
    assert.equal(finished, false)
    assert.equal(sink.events.length, 0, 'nothing runs while the packer is full')

    sink.open()
    assert.deepEqual(await running, {})
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

  it('stops cleanly when it never started, and when stopped twice', async () => {
    const { runner, base } = await started()
    await createRuntimeRunner().stop?.(base)
    await runner.stop?.(base)
    await runner.stop?.(base)
  })
})
