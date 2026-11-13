// How a fork's end becomes one `WorkerExit` (T9.5, B21a): reported once the child has exited and its
// IPC channel has disconnected, with its stdio closed too only for the exit that reads stderr.
// Driven by hand over event emitters, so no timing decides what is reported.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { describe, it } from 'node:test'
import type { WorkerExit } from '@provino/types'
import { type ChildEvents, reportChildExit } from './forks.ts'
import { oomExit } from './shared.ts'

/** A child, its link and its stderr watch, with a grace long enough that it never decides. */
function fakeChild(
  options: {
    readonly pid?: number | undefined
    readonly sawHeapOom?: boolean
    readonly graceMs?: number
  } = {},
) {
  const child = new EventEmitter()
  const link = new EventEmitter()
  const printed: string[] = []
  const exits: WorkerExit[] = []
  const reported = Promise.withResolvers<WorkerExit>()
  reportChildExit(
    {
      child: Object.assign(child, { pid: 'pid' in options ? options.pid : 4242 }) as ChildEvents,
      link: { onExit: (listener) => link.once('closed', listener) },
      watch: { sawHeapOom: options.sawHeapOom ?? false },
      limitMb: 64,
      stderr: new Writable({
        write(chunk: Buffer | string, _encoding, done) {
          printed.push(chunk.toString())
          done()
        },
      }),
      graceMs: options.graceMs ?? 3_600_000,
    },
    (exit) => {
      exits.push(exit)
      reported.resolve(exit)
    },
  )
  return {
    exits,
    /** Settles with the first exit reported. */
    reported: reported.promise,
    printed,
    exit: (code: number | null, signal: NodeJS.Signals | null = null) =>
      child.emit('exit', code, signal),
    disconnect: () => link.emit('closed'),
    close: () => child.emit('close'),
    error: (error: Error) => child.emit('error', error),
  }
}

describe('reportChildExit', () => {
  it('reports a clean exit once the child has exited and its channel has disconnected, without its stdio', () => {
    // A test's grandchild can hold the stderr pipe open for as long as it likes.
    const child = fakeChild()
    child.exit(0)
    assert.deepEqual(child.exits, [], 'not before the channel has disconnected')
    child.disconnect()
    assert.deepEqual(child.exits, [{ type: 'exit', code: 0 }])
  })

  it('reports an exit code, a null code as 0 and any signal but SIGABRT without waiting for stdio', () => {
    for (const [code, signal, expected] of [
      [3, null, { type: 'exit', code: 3 }],
      [null, null, { type: 'exit', code: 0 }],
      [null, 'SIGKILL', { type: 'signal', signal: 'SIGKILL', likelyOom: false }],
      [null, 'SIGSEGV', { type: 'signal', signal: 'SIGSEGV', likelyOom: false }],
    ] as const) {
      const child = fakeChild()
      child.disconnect()
      child.exit(code, signal)
      assert.deepEqual(child.exits, [expected], `${code} ${signal}`)
    }
  })

  it('reports the exit once, however the close and the channel come after it', () => {
    const child = fakeChild()
    child.exit(0)
    child.disconnect()
    child.close()
    child.disconnect()
    assert.equal(child.exits.length, 1)
  })

  it('waits for the stdio of a SIGABRT, which is read for V8’s out-of-memory line', () => {
    const child = fakeChild({ sawHeapOom: true })
    child.disconnect()
    child.exit(null, 'SIGABRT')
    assert.deepEqual(child.exits, [], 'the last of its stderr may not have arrived')
    child.close()
    assert.deepEqual(child.exits, [oomExit(64)])
  })

  it('reports a SIGABRT without V8’s line as a signal that was likely an OOM', () => {
    const child = fakeChild({ sawHeapOom: false })
    child.disconnect()
    child.exit(null, 'SIGABRT')
    child.close()
    assert.deepEqual(child.exits, [{ type: 'signal', signal: 'SIGABRT', likelyOom: true }])
  })

  it('gives a grandchild that holds the channel and the pipes a grace after the exit, then ignores it', async () => {
    const child = fakeChild({ graceMs: 5 })
    child.exit(null, 'SIGABRT')
    assert.deepEqual(await child.reported, { type: 'signal', signal: 'SIGABRT', likelyOom: true })
    assert.equal(child.exits.length, 1)
  })

  it('reports a child that never spawned as exit code 1, after printing why', () => {
    const child = fakeChild({ pid: undefined })
    child.error(new Error('spawn ENOENT'))
    assert.deepEqual(child.exits, [{ type: 'exit', code: 1 }])
    assert.match(child.printed.join(''), /spawn ENOENT/)
  })

  it('leaves an error of a child that did spawn (a send on a closing channel) to its exit', () => {
    const child = fakeChild()
    child.error(new Error('channel closed'))
    assert.deepEqual(child.exits, [])
    assert.deepEqual(child.printed, [])
  })
})
