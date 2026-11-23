import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import type { LiveTerminal } from '@provino/reporters/live'
import { describe, it } from 'provino'
import {
  hookTerminal,
  pinnedStream,
  RESTORE_SIGNALS,
  streamOver,
  type TerminalHost,
} from './live-terminal.ts'

/** A live terminal that records what is asked of it. */
function fakeTerminal(): LiveTerminal & { readonly calls: string[]; readonly passed: string[] } {
  const calls: string[] = []
  const passed: string[] = []
  return {
    calls,
    passed,
    restore: () => calls.push('restore'),
    resize: (columns) => calls.push(`resize ${columns}`),
    passthrough: { write: (chunk) => void passed.push(chunk) },
  }
}

/** A stream with its own `write`, as a test file's process sees `process.stdout`. */
class Recording extends Writable {
  text = ''
  readonly isTTY: boolean
  constructor(isTTY: boolean) {
    super()
    this.isTTY = isTTY
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.text += chunk.toString()
    done()
  }
}

/** A process stand-in: listeners by event, the signals it was sent, and two streams. */
function fakeHost(options: { stdoutTTY?: boolean; stderrTTY?: boolean } = {}) {
  const events = new EventEmitter()
  const killed: NodeJS.Signals[] = []
  const stdout = new Recording(options.stdoutTTY ?? true)
  const stderr = new Recording(options.stderrTTY ?? true)
  const host: TerminalHost = {
    once: (event: string, listener: (signal: NodeJS.Signals) => void) =>
      events.once(event, listener),
    off: (event: string, listener: (signal: NodeJS.Signals) => void) => events.off(event, listener),
    listenerCount: (event) => events.listenerCount(event),
    kill: (_pid, signal) => killed.push(signal),
    pid: 4242,
    stdout,
    stderr,
  }
  return { host, events, killed, stdout, stderr }
}

describe('hookTerminal', () => {
  it('a signal nobody else handles restores the terminal, removes its handlers and is raised again', () => {
    const terminal = fakeTerminal()
    const { host, events, killed } = fakeHost()
    const stderr = new Recording(true)
    hookTerminal(terminal, stderr, host)
    for (const signal of RESTORE_SIGNALS) assert.equal(events.listenerCount(signal), 1, signal)
    events.emit('SIGQUIT', 'SIGQUIT')
    assert.deepEqual(terminal.calls, ['restore'])
    assert.deepEqual(killed, ['SIGQUIT'], 'raised again, so its default action and code stay')
    for (const signal of RESTORE_SIGNALS) assert.equal(events.listenerCount(signal), 0, signal)
    assert.equal(events.listenerCount('exit'), 0)
  })

  it('leaves a signal to the handler already there (the bin’s SIGINT, SIGTERM and SIGHUP)', () => {
    const terminal = fakeTerminal()
    const { host, events, killed } = fakeHost()
    const theBins = (): void => {}
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) events.on(signal, theBins)
    const dispose = hookTerminal(terminal, new Recording(true), host)
    assert.equal(events.listenerCount('SIGTERM'), 1, 'only the bin’s')
    assert.equal(events.listenerCount('SIGQUIT'), 1, 'ours: nobody else handles it')
    events.emit('SIGTERM', 'SIGTERM')
    assert.deepEqual(killed, [], 'the bin ends the run, which restores the terminal itself')
    dispose()
    assert.equal(events.listenerCount('SIGQUIT'), 0)
    assert.equal(events.listenerCount('SIGTERM'), 1)
  })

  it('the restore on exit and the width on resize, both removed by dispose, which restores once', () => {
    const terminal = fakeTerminal()
    const { host, events } = fakeHost()
    const stderr = new Recording(true)
    Object.defineProperty(stderr, 'columns', { value: 72, configurable: true })
    const dispose = hookTerminal(terminal, stderr, host)
    stderr.emit('resize')
    events.emit('exit')
    assert.deepEqual(terminal.calls, ['resize 72', 'restore'])
    dispose()
    dispose()
    assert.deepEqual(terminal.calls, ['resize 72', 'restore', 'restore'], 'once, however often')
    assert.equal(stderr.listenerCount('resize'), 0)
    assert.equal(events.listenerCount('exit'), 0)
  })

  it('routes the process’s own writes to a terminal through passthrough, and puts write back exactly', () => {
    const terminal = fakeTerminal()
    const { host, stdout, stderr } = fakeHost({ stdoutTTY: true, stderrTTY: true })
    const protoWrite = Writable.prototype.write
    let called = false
    const dispose = hookTerminal(terminal, new Recording(true), host)
    stdout.write('to stdout\n')
    stderr.write(Buffer.from('to stderr\n'), () => {
      called = true
    })
    assert.deepEqual(terminal.passed, ['to stdout\n', 'to stderr\n'])
    assert.equal(stdout.text, '', 'nothing reached the stream itself')
    dispose()
    assert.equal(Object.hasOwn(stdout, 'write'), false)
    assert.equal(Object.hasOwn(stderr, 'write'), false)
    assert.equal(stdout.write, protoWrite)
    stdout.write('after\n')
    assert.equal(stdout.text, 'after\n')
    return new Promise<void>((resolve) =>
      process.nextTick(() => {
        assert.ok(called, 'the write’s callback ran')
        resolve()
      }),
    )
  })

  it('leaves a piped stdout alone: only a stream that is the terminal can draw over the footer', () => {
    const terminal = fakeTerminal()
    const { host, stdout } = fakeHost({ stdoutTTY: false })
    const dispose = hookTerminal(terminal, new Recording(true), host)
    stdout.write('to the pipe\n')
    assert.deepEqual(terminal.passed, [])
    assert.equal(stdout.text, 'to the pipe\n')
    dispose()
  })

  it('a stream that had its own write gets that write back', () => {
    const terminal = fakeTerminal()
    const { host, stdout } = fakeHost()
    const own: Recording['write'] = () => true
    stdout.write = own
    const dispose = hookTerminal(terminal, new Recording(true), host)
    assert.notEqual(stdout.write, own)
    dispose()
    assert.equal(stdout.write, own)
  })
})

describe('streamOver', () => {
  it('answers isTTY, columns and hasColors as stderr does, and end() does not end it', async () => {
    const passed: string[] = []
    const stderr = Object.assign(new Recording(true), {
      columns: 90,
      hasColors: (depth?: number) => depth === undefined || depth <= 8,
    })
    const stream = streamOver({ write: (chunk) => void passed.push(chunk) }, stderr)
    assert.equal(Reflect.get(stream, 'isTTY'), true)
    assert.equal(Reflect.get(stream, 'columns'), 90)
    const hasColors: unknown = Reflect.get(stream, 'hasColors')
    assert.ok(typeof hasColors === 'function')
    assert.equal(Reflect.apply(hasColors, stream, []), true)
    assert.equal(Reflect.apply(hasColors, stream, [24]), false)
    stream.end()
    await new Promise<void>((resolve) => stream.write('still open\n', () => resolve()))
    assert.deepEqual(passed, ['still open\n'])
    assert.equal(Reflect.get(stream, 'fd'), undefined, 'no descriptor: the writes are the sink’s')
  })

  it('a stderr that is no terminal stays one that is not', () => {
    const stream = streamOver({ write: () => {} }, new Recording(false))
    assert.equal(Reflect.get(stream, 'isTTY'), false)
    assert.equal(Reflect.apply(Reflect.get(stream, 'hasColors'), stream, []), false)
  })
})

describe('pinnedStream', () => {
  it('keeps writing with the write it was given, whatever the stream’s write becomes', () => {
    const stderr = new Recording(true)
    const pinned = pinnedStream(stderr)
    const routed: string[] = []
    stderr.write = (chunk: unknown) => {
      routed.push(String(chunk))
      return true
    }
    pinned.write('the frame\n')
    assert.equal(stderr.text, 'the frame\n')
    assert.deepEqual(routed, [])
  })
})
