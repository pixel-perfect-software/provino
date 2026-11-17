import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recordingSink } from '../test-support.ts'
import { createTerminalSession } from './session.ts'
import { createTimedWriter } from './writer.ts'

const ESC = String.fromCharCode(27)
const HIDE = `${ESC}[?25l`
const SHOW = `${ESC}[?25h`
const BEGIN = `${ESC}[?2026h`
const END = `${ESC}[?2026l`

function make() {
  const sink = recordingSink()
  const writer = createTimedWriter(sink)
  return { sink, session: createTerminalSession(writer, 80) }
}

test('the cursor is hidden on the first frame only, and each frame is one synchronized write', () => {
  const { sink, session } = make()
  assert.equal(session.draw([], ['status']), true)
  assert.equal(session.draw([], ['status', 'w1']), true)
  const [first, second] = sink.writes()
  assert.equal(first, `${BEGIN}${HIDE}status\n${END}`)
  assert.ok(!(second as string).includes(HIDE))
  assert.ok((second as string).startsWith(BEGIN) && (second as string).endsWith(END))
  assert.equal(sink.writes().length, 2)
})

test('an unchanged footer draws nothing', () => {
  const { sink, session } = make()
  session.draw([], ['status'])
  assert.equal(session.draw([], ['status']), false)
  assert.equal(sink.writes().length, 1)
})

test('restore erases the footer and shows the cursor, once', () => {
  const { sink, session } = make()
  session.draw([], ['status', 'w1'])
  session.restore()
  assert.equal(sink.writes().at(-1), `${ESC}[2F${ESC}[0J${SHOW}`)
  const count = sink.writes().length
  session.restore()
  assert.equal(sink.writes().length, count)
  assert.equal(session.draw([], ['again']), false)
})

test('a session that never drew writes nothing on restore', () => {
  const { sink, session } = make()
  session.restore()
  assert.deepEqual(sink.writes(), [])
})

test('finish erases the footer, writes the lines and shows the cursor in one write', () => {
  const { sink, session } = make()
  session.draw([], ['status'])
  session.finish(['final'])
  assert.equal(sink.writes().at(-1), `${ESC}[1F${ESC}[0Jfinal\n${SHOW}`)
  const count = sink.writes().length
  session.restore()
  assert.equal(sink.writes().length, count)
})

test('a frame is not written, and nothing is consumed, while the stream has not drained', () => {
  const { sink, session } = make()
  sink.full = true
  assert.equal(session.draw([], ['a']), true) // this write goes through and fills the pipe
  assert.equal(session.draw(['kept'], ['b']), false)
  assert.equal(sink.writes().length, 1)
  sink.drain()
  assert.equal(session.draw(['kept'], ['b']), true)
  assert.ok((sink.writes().at(-1) as string).includes('kept'))
})
