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

describe('console call sites (orchestrator.consoleOrigin: stack)', () => {
  function located(on: boolean) {
    const events: ConsoleEvent[] = []
    const c = createConsoleCapture({
      emit: (event) => events.push(event),
      currentTaskId: () => null,
      origin: () => on,
    })
    return { c, events }
  }

  it('keeps no origin unless asked', () => {
    const { c, events } = located(false)
    c.console.log('a')
    assert.equal(events[0]?.origin, null)
  })

  it('keeps the first frame of a log, as V8 names it, with the call’s position', () => {
    const { c, events } = located(true)
    c.console.log('a')
    const origin = events[0]?.origin ?? ''
    assert.match(origin, /^at .*console\.test\.ts:\d+:\d+\)?$/)
    assert.equal(origin.includes('\n'), false)
  })

  it('keeps the whole stack of a warn or an error, which Jest prints with a code frame and every frame', () => {
    const { c, events } = located(true)
    function helper(): void {
      c.console.error('e')
    }
    helper()
    c.console.warn('w')
    const lines = (events[0]?.origin ?? '').split('\n').map((line) => line.trim())
    assert.match(lines[0] ?? '', /^at helper \(.*console\.test\.ts:\d+:\d+\)$/)
    assert.ok(lines.length > 1, 'the caller of the helper is there too')
    assert.ok(lines.every((line) => line.startsWith('at ')))
    assert.ok((events[1]?.origin ?? '').split('\n').length > 1)
  })

  it('keeps the site of the user’s call for a method that prints through others', () => {
    const { c, events } = located(true)
    c.console.table([{ a: 1 }])
    assert.match(events[0]?.origin ?? '', /console\.test\.ts/)
  })

  it('keeps no origin, and does not throw in the user’s call, when Error.prepareStackTrace does not give a string', () => {
    const { c, events } = located(true)
    const original = Error.prepareStackTrace
    try {
      Error.prepareStackTrace = (_error, frames) => frames
      c.console.log('a')
      c.console.warn('b')
      Error.prepareStackTrace = () => {
        throw new Error('broken formatter')
      }
      c.console.error('c')
    } finally {
      Error.prepareStackTrace = original
    }
    assert.deepEqual(
      events.map((event) => [event.text, event.origin]),
      [
        ['a\n', null],
        ['b\n', null],
        ['c\n', null],
      ],
    )
  })

  it('leaves a direct stream write with no origin', () => {
    const { c, events } = located(true)
    const out = stream()
    const installed = c.install({ stdout: out, stderr: stream() })
    ;(out as { write(chunk: string): boolean }).write('raw')
    installed.restore()
    assert.equal(events[0]?.level, null)
    assert.equal(events[0]?.origin, null)
  })
})

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

  it('reset gives a fresh console: no open group or count carries over', () => {
    const { c, events } = capture()
    c.console.group('open')
    c.console.count('n')
    c.reset()
    c.console.log('after')
    c.console.count('n')
    assert.deepEqual(
      events.map((e) => e.text),
      ['open\n', '  n: 1\n', 'after\n', 'n: 1\n'],
    )
  })

  it('records a console call made while another prints under its own level', () => {
    const { c, events } = capture()
    const noisy = {
      [Symbol.for('nodejs.util.inspect.custom')]: () => {
        c.console.error('inner')
        return 'outer'
      },
    }
    c.console.log(noisy)
    assert.deepEqual(
      brief(events).map(({ stream, level, text }) => [stream, level, text]),
      [
        ['stderr', 'error', 'inner\n'],
        ['stdout', 'log', 'outer\n'],
      ],
    )
  })

  it('decodes direct writes as a real stream does', () => {
    const { c, events } = capture()
    const stdout = stream()
    c.install({ stdout, stderr: stream() })
    stdout.write(Buffer.from('héllo'), 'latin1') // a Buffer's encoding is ignored
    stdout.write('68690a', 'hex') // a string's is applied
    stdout.write(Buffer.from('ok'), 'buffer')
    const euro = Buffer.from('€\n')
    stdout.write(euro.subarray(0, 1)) // a character split across writes
    stdout.write(euro.subarray(1))
    assert.deepEqual(
      events.map((e) => e.text),
      ['héllo', 'hi\n', 'ok', '€\n'],
    )
  })
})
