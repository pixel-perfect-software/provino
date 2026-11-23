import assert from 'node:assert/strict'
import { test } from 'provino'
import { recordingSink } from '../test-support.ts'
import { createTimedWriter } from './writer.ts'

/** A descriptor that takes `chunk` bytes a call, and fails with `code` once it has taken `limit`. */
function fakeFd(options: { chunk: number; limit?: number; code?: string }) {
  const taken: number[] = []
  let total = 0
  return {
    taken,
    text: () => Buffer.from(taken).toString(),
    writeFd(_fd: number, data: Uint8Array, offset: number): number {
      if (options.limit !== undefined && total >= options.limit) {
        throw Object.assign(new Error(options.code ?? 'EAGAIN'), { code: options.code ?? 'EAGAIN' })
      }
      let n = Math.min(options.chunk, data.length - offset)
      if (options.limit !== undefined) n = Math.min(n, options.limit - total)
      for (let i = 0; i < n; i++) taken.push(data[offset + i] as number)
      total += n
      return n
    },
  }
}

test('writeSync loops on a partial write until every byte is at the descriptor', () => {
  const sink = recordingSink()
  sink.fd = 1
  const fd = fakeFd({ chunk: 3 })
  const writer = createTimedWriter(sink, { writeFd: fd.writeFd })
  writer.writeSync('hello, terminal ✓')
  assert.equal(fd.text(), 'hello, terminal ✓')
  assert.deepEqual(sink.writes(), [])
})

test('on EAGAIN after a partial write only the rest goes to the stream, which then is waited for', () => {
  const sink = recordingSink()
  sink.fd = 1
  sink.full = true
  const fd = fakeFd({ chunk: 4, limit: 6 })
  const writer = createTimedWriter(sink, { writeFd: fd.writeFd })
  writer.writeSync('0123456789')
  assert.equal(fd.text(), '012345')
  assert.deepEqual(sink.writes(), ['6789'])
  assert.equal(writer.ready(), false)
})

test('a stream that holds buffered data is written behind, never around, by writeSync', () => {
  const sink = recordingSink()
  sink.fd = 1
  sink.writableLength = 12
  const fd = fakeFd({ chunk: 100 })
  const writer = createTimedWriter(sink, { writeFd: fd.writeFd })
  writer.writeSync('later')
  assert.equal(fd.text(), '')
  assert.deepEqual(sink.writes(), ['later'])
})

test('writeAlways keeps text while the stream is full and writes it, in order, on drain', () => {
  const sink = recordingSink()
  sink.full = true
  let ready = 0
  const writer = createTimedWriter(sink, { onReady: () => ready++ })
  assert.equal(writer.write('frame'), true)
  writer.writeAlways('one\n')
  writer.writeAlways('two\n')
  assert.deepEqual(sink.writes(), ['frame'])
  sink.drain()
  assert.deepEqual(sink.writes(), ['frame', 'one\n', 'two\n'])
  assert.equal(ready, 1)
})

test('an error while the stream is full ends the writer: no throw, no more writes, the error kept', () => {
  const sink = recordingSink()
  sink.full = true
  const errors: unknown[] = []
  const writer = createTimedWriter(sink, { onError: (cause) => errors.push(cause) })
  writer.write('frame')
  writer.writeAlways('lost')
  const failure = new Error('EPIPE')
  sink.emit('error', failure)
  assert.deepEqual(errors, [failure])
  assert.equal(writer.ready(), false)
  assert.equal(writer.write('x'), false)
  writer.writeAlways('y')
  writer.writeSync('z')
  assert.deepEqual(sink.writes(), ['frame'])
  assert.equal(sink.listenerCount(), 0, 'the other listeners are removed')
})

test('a close while the stream is full ends the writer without an error', () => {
  const sink = recordingSink()
  sink.full = true
  const errors: unknown[] = []
  const writer = createTimedWriter(sink, { onError: (cause) => errors.push(cause) })
  writer.write('frame')
  sink.emit('close')
  assert.deepEqual(errors, [])
  assert.equal(writer.ready(), false)
  writer.writeAlways('y')
  assert.deepEqual(sink.writes(), ['frame'])
  assert.equal(sink.listenerCount(), 0)
})

test('a drain removes the error and close listeners', () => {
  const sink = recordingSink()
  sink.full = true
  const writer = createTimedWriter(sink)
  writer.write('frame')
  assert.equal(sink.listenerCount(), 3)
  sink.drain()
  assert.equal(sink.listenerCount(), 0)
})
