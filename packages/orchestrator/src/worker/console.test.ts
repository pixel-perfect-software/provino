// Console capture: each write is one event with Node's own formatting, the outermost method as
// its level, direct stream writes as `level: null`, the current task, and a clean restore.
import assert from 'node:assert/strict'
import { Console } from 'node:console'
import { describe, it } from 'node:test'
import type { RuntimeEventOf, TaskId } from '@provino/types'
import { createConsoleCapture, type WritableLike } from './console.ts'

type ConsoleEvent = RuntimeEventOf<'console'>

function capture(task: { current: TaskId | null } = { current: null }) {
  const events: ConsoleEvent[] = []
  let clock = 0
  const c = createConsoleCapture({
    emit: (event) => events.push(event),
    currentTaskId: () => task.current,
    now: () => ++clock,
  })
  return { c, events, task }
}

/** A stream stand-in whose own `write` records what reaches it and calls back. */
function stream(): WritableLike & { readonly through: string[] } {
  const through: string[] = []
  return {
    through,
    write(chunk: string | Uint8Array, ...rest: unknown[]) {
      through.push(String(chunk))
      const callback = rest.find((arg) => typeof arg === 'function') as (() => void) | undefined
      callback?.()
      return true
    },
  }
}

const brief = (events: readonly ConsoleEvent[]) =>
  events.map(({ stream, level, text, taskId }) => ({ stream, level, text, taskId }))

describe('createConsoleCapture', () => {
  it('records each call with its level, stream and Node’s formatting', () => {
    const { c, events } = capture()
    c.console.log('a %s %d', 'b', 1)
    c.console.info('i')
    c.console.debug('d')
    c.console.warn('w')
    c.console.error(new Map([[1, 2]]))
    c.console.dir({ x: [1] })
    assert.deepEqual(brief(events), [
      { stream: 'stdout', level: 'log', text: 'a b 1\n', taskId: null },
      { stream: 'stdout', level: 'info', text: 'i\n', taskId: null },
      { stream: 'stdout', level: 'debug', text: 'd\n', taskId: null },
      { stream: 'stderr', level: 'warn', text: 'w\n', taskId: null },
      { stream: 'stderr', level: 'error', text: 'Map(1) { 1 => 2 }\n', taskId: null },
      { stream: 'stdout', level: 'dir', text: '{ x: [ 1 ] }\n', taskId: null },
    ])
    assert.deepEqual(
      events.map((e) => e.t),
      [1, 2, 3, 4, 5, 6],
    )
    assert.ok(events.every((e) => e.type === 'console' && e.origin === null))
  })

  it('keeps the outermost method as the level, and indents groups', () => {
    const { c, events } = capture()
    c.console.group('g')
    c.console.count('n')
    c.console.count('n')
    c.console.assert(false, 'bad')
    c.console.groupEnd()
    c.console.table([{ a: 1 }])
    assert.deepEqual(
      brief(events).map(({ level, text }) => [level, text]),
      [
        ['group', 'g\n'],
        ['count', '  n: 1\n'],
        ['count', '  n: 2\n'],
        ['assert', '  Assertion failed: bad\n'],
        ['table', events.at(-1)?.text],
      ],
    )
    assert.match(events.at(-1)?.text ?? '', /│ \(index\) │ a │/)
  })

  it('formats exactly as a plain Console does', () => {
    const { c, events } = capture()
    const plain: string[] = []
    const out = { write: (chunk: string) => plain.push(chunk) } as unknown as NodeJS.WritableStream
    const reference = new Console({ stdout: out, stderr: out, ignoreErrors: false })
    for (const target of [c.console, reference]) {
      target.group('outer')
      target.log('%o', { deep: { er: [1, 2] } })
      target.group()
      target.error('x', 1n, Symbol('s'))
      target.groupEnd()
      target.groupEnd()
      target.log('done')
    }
    assert.deepEqual(
      events.map((e) => e.text),
      plain,
    )
  })

  it('ties each write to the task running when it happens', () => {
    const { c, events, task } = capture()
    c.console.log('before')
    task.current = 'test-1' as TaskId
    c.console.log('during')
    task.current = null
    c.console.log('after')
    assert.deepEqual(
      events.map((e) => e.taskId),
      [null, 'test-1', null],
    )
  })

  it('install patches the streams and the target console, and restore undoes both', async () => {
    const { c, events } = capture()
    const stdout = stream()
    const stderr = stream()
    const original = new Console({ stdout: process.stdout })
    const target = { console: original }
    const installed = c.install({ stdout, stderr }, target)
    assert.equal(target.console, c.console)
    stdout.write('raw out')
    stderr.write(new TextEncoder().encode('raw err\n'))
    let calledBack = false
    stdout.write('with callback', () => {
      calledBack = true
    })
    target.console.log('via console')
    await new Promise((resolve) => process.nextTick(resolve))
    assert.equal(calledBack, true)
    assert.deepEqual(brief(events), [
      { stream: 'stdout', level: null, text: 'raw out', taskId: null },
      { stream: 'stderr', level: null, text: 'raw err\n', taskId: null },
      { stream: 'stdout', level: null, text: 'with callback', taskId: null },
      { stream: 'stdout', level: 'log', text: 'via console\n', taskId: null },
    ])
    assert.deepEqual(stdout.through, [], 'captured writes don’t reach the real stream')
    await installed.flush()
    assert.deepEqual(stdout.through, [''], 'flush writes through the real write')
    installed.restore()
    assert.equal(target.console, original)
    stdout.write('after restore')
    assert.deepEqual(stdout.through, ['', 'after restore'])
    assert.equal(events.length, 4)
  })

  it('skips empty writes', () => {
    const { c, events } = capture()
    const stdout = stream()
    c.install({ stdout, stderr: stream() })
    stdout.write('')
    assert.equal(events.length, 0)
  })
})
