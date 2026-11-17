import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Reporter, ReporterEvents } from '@provino/types'
import { createReporterBus } from '../bus.ts'
import {
  buildFile,
  FIXTURE_FILES,
  FIXTURE_SNAPSHOTS,
  playRun,
  resultOf,
  testEndEvent,
} from '../internal/test-support.ts'
import { createRunState, type RunState } from './model/state.ts'
import { createLiveReporter, MAX_WORKER_LINES, provinoReporter } from './reporter.ts'
import { GLYPHS } from './terminal/glyphs.ts'
import { fakeClock, manualScheduler, recordingSink } from './test-support.ts'

const ESC = String.fromCharCode(27)

function setup(options: { live?: boolean; columns?: number; glyphs?: 'emoji' | 'ascii' } = {}) {
  const clock = fakeClock()
  const scheduler = manualScheduler(clock)
  const sink = recordingSink()
  const reporter = provinoReporter({
    stream: sink,
    live: options.live ?? true,
    colour: false,
    columns: options.columns ?? 80,
    glyphs: GLYPHS[options.glyphs ?? 'emoji'],
    scheduler,
  })
  return { clock, scheduler, sink, reporter }
}

/** Wraps every handler of `reporter` so each call is checked against performance rule 1. */
function guarded(
  reporter: Reporter,
  sink: { writes(): readonly string[] },
  scheduler: { clockReads(): number },
): Reporter {
  const wrapped: Record<string, unknown> = { name: reporter.name }
  for (const [key, value] of Object.entries(reporter)) {
    if (typeof value !== 'function' || key === 'lastError') continue
    wrapped[key] = (...args: unknown[]) => {
      const writes = sink.writes().length
      const reads = scheduler.clockReads()
      const returned = (value as (...a: unknown[]) => unknown).apply(reporter, args)
      assert.equal(returned, undefined, `${key} returned something to await`)
      if (key !== 'run:end') assert.equal(sink.writes().length, writes, `${key} wrote`)
      assert.ok(scheduler.clockReads() - reads <= 1, `${key} read the clock more than once`)
    }
  }
  return wrapped as unknown as Reporter
}

test('rule 1: every handler over the fixture run writes nothing, reads the clock at most once and returns at once', async () => {
  const { scheduler, sink, reporter } = setup()
  const bus = createReporterBus([guarded(reporter, sink, scheduler)])
  await playRun(bus, FIXTURE_FILES, { snapshots: FIXTURE_SNAPSHOTS })
  assert.deepEqual(bus.failures(), [])
  assert.equal(sink.writes().length, 1, 'run:end is the only write, with no frame ticked')
})

test('rule 1: a handler does the same work for every event however long the run', async () => {
  const test1 = buildFile({ path: 'a.test.ts', tests: [{ path: ['t'] }] })
  const first = test1.tests[0]
  assert.ok(first)
  const task = first.task
  const event = testEndEvent(task, resultOf({ path: ['t'] }))

  async function operations(events: number): Promise<number> {
    const real = createRunState()
    let calls = 0
    const counting = { ...real } as Record<string, unknown>
    for (const [key, value] of Object.entries(real)) {
      if (typeof value !== 'function') continue
      counting[key] = (...args: unknown[]) => {
        calls++
        return (value as (...a: unknown[]) => unknown)(...args)
      }
    }
    const reporter = createLiveReporter(
      {
        stream: recordingSink(),
        live: true,
        colour: false,
        columns: 80,
        glyphs: GLYPHS.emoji,
        scheduler: manualScheduler(),
      },
      counting as unknown as RunState,
    )
    await reporter['run:start']?.({ root: '/p', projects: [''], startTime: 0, watch: false }, [
      test1.info,
    ])
    await reporter['file:start']?.(test1.info, 0)
    const before = calls
    for (let i = 0; i < events; i++) await reporter['task:end']?.(task, event)
    return calls - before
  }

  const small = await operations(1000)
  const large = await operations(100_000)
  assert.equal(small, 1000, 'one state call per event')
  assert.equal(large, 100_000)
})

test('the footer: a status line and a line per busy worker, drawn on a tick', async () => {
  const { scheduler, sink, reporter } = setup()
  const bus = createReporterBus([reporter])
  const a = buildFile({
    path: 'src/a.test.ts',
    tests: [{ path: ['x'] }, { path: ['y'], state: 'fail' }],
  })
  const b = buildFile({ path: 'src/b.test.ts', tests: [{ path: ['z'] }] })
  await bus.emit('run:start', { root: '/p', projects: [''], startTime: 0, watch: false }, [
    a.info,
    b.info,
  ])
  await bus.emit('file:start', a.info, 0)
  await bus.emit('file:start', b.info, 1)
  await bus.emit(
    'task:end',
    a.tests[0]?.task as never,
    testEndEvent(a.tests[0]?.task as never, resultOf({ path: ['x'] })),
  )
  assert.equal(sink.writes().length, 0, 'handlers write nothing')
  assert.equal(scheduler.tick(), true)
  assert.equal(sink.writes().length, 1)
  const frame = sink.text()
  assert.ok(frame.startsWith(`${ESC}[?2026h${ESC}[?25l`))
  assert.ok(frame.includes('✅ 1'))
  assert.ok(frame.includes('0 of 2 files'))
  assert.ok(frame.includes('src/a.test.ts'))
  assert.ok(frame.includes('src/b.test.ts'))
  assert.ok(frame.endsWith(`${ESC}[?2026l`))
  // Nothing changed and the spinner is not due: the next tick, asked for by the frame, redraws the spinner only.
  scheduler.clock.advance(120)
  assert.equal(scheduler.tick(), true)
  assert.equal(sink.writes().length, 2)
})

test('a frame with nothing new writes nothing', async () => {
  const { scheduler, sink, reporter } = setup()
  const bus = createReporterBus([reporter])
  await bus.emit('run:start', { root: '/p', projects: [''], startTime: 0, watch: false }, [])
  assert.equal(scheduler.tick(), true)
  const count = sink.writes().length
  assert.equal(scheduler.tick(), false)
  assert.equal(sink.writes().length, count)
})

test('more busy workers than the footer has room for are counted on one line', async () => {
  const { scheduler, sink, reporter } = setup({ columns: 100 })
  const bus = createReporterBus([reporter])
  const files = Array.from(
    { length: MAX_WORKER_LINES + 3 },
    (_, i) => buildFile({ path: `f${i}.test.ts` }).info,
  )
  await bus.emit('run:start', { root: '/p', projects: [''], startTime: 0, watch: false }, files)
  for (const [i, file] of files.entries()) await reporter['file:start']?.(file, i)
  scheduler.tick()
  const rows = sink.text().split('\n')
  assert.ok(rows.some((row) => row.includes('+ 3 more workers')))
  assert.equal(rows.filter((row) => /f\d+\.test\.ts/.test(row)).length, MAX_WORKER_LINES)
})

test('run:end erases the footer, writes the final line and shows the cursor, once', async () => {
  const { scheduler, sink, reporter } = setup()
  const bus = createReporterBus([reporter])
  await bus.emit('run:start', { root: '/p', projects: [''], startTime: 0, watch: false }, [])
  scheduler.tick()
  await reporter['run:end']?.({ reason: 'passed', files: [], unhandled: [], durationMs: 1234 })
  const last = sink.writes().at(-1) as string
  assert.ok(last.includes('of'))
  assert.ok(last.endsWith(`${ESC}[?25h`))
  assert.ok(last.includes('1.2s'))
  const count = sink.writes().length
  reporter.terminal.restore()
  assert.equal(sink.writes().length, count, 'restore after run:end writes nothing')
  assert.equal(scheduler.stopped(), true)
})

test('without a terminal there is no timer and no escape: the final line is plain text', async () => {
  const { scheduler, sink, reporter } = setup({ live: false })
  const bus = createReporterBus([reporter])
  await playRun(bus, FIXTURE_FILES, { durationMs: 2000 })
  assert.equal(scheduler.requests(), 0)
  assert.ok(!sink.text().includes(ESC))
  assert.match(sink.text(), /✅ \d+.* of \d+ files {2}2\.0s\n$/)
})

test('passthrough text goes above the footer at the next frame', async () => {
  const { scheduler, sink, reporter } = setup()
  const bus = createReporterBus([reporter])
  await bus.emit('run:start', { root: '/p', projects: [''], startTime: 0, watch: false }, [])
  scheduler.tick()
  reporter.terminal.passthrough.write('warn: one\nwarn: tw')
  reporter.terminal.passthrough.write('o\n')
  assert.equal(sink.writes().length, 1)
  scheduler.tick()
  const frame = sink.writes().at(-1) as string
  assert.ok(frame.includes('warn: one\nwarn: two\n'))
})

test('a frame that throws restores the terminal, keeps the error and lets the run end', async () => {
  const { scheduler, sink, reporter } = setup()
  const bus = createReporterBus([reporter])
  await bus.emit('run:start', { root: '/p', projects: [''], startTime: 0, watch: false }, [])
  scheduler.tick()
  const write = sink.write.bind(sink)
  let broken = true
  sink.write = (chunk) => {
    if (broken && typeof chunk === 'string' && !chunk.includes('status') && chunk.includes('✅'))
      throw new Error('EPIPE')
    return write(chunk)
  }
  await reporter['task:end']?.(
    buildFile({ path: 'a.test.ts', tests: [{ path: ['t'] }] }).tests[0]?.task as never,
    testEndEvent(
      buildFile({ path: 'a.test.ts', tests: [{ path: ['t'] }] }).tests[0]?.task as never,
      resultOf({ path: ['t'] }),
    ),
  )
  scheduler.tick()
  assert.equal(reporter.lastError?.()?.message, 'EPIPE')
  assert.ok(sink.writes().at(-1)?.endsWith(`${ESC}[?25h`), 'the cursor is shown again')
  broken = false
  await reporter['run:end']?.({ reason: 'passed', files: [], unhandled: [], durationMs: 5 })
  assert.ok(sink.text().includes('of 0 files'))
})

test('a second run:start starts clean and draws again', async () => {
  const { scheduler, sink, reporter } = setup()
  const bus = createReporterBus([reporter])
  await playRun(bus, FIXTURE_FILES, {})
  const before = sink.writes().length
  const events: (keyof ReporterEvents)[] = ['run:start']
  assert.deepEqual(events, ['run:start'])
  await bus.emit('run:start', { root: '/p', projects: [''], startTime: 0, watch: true }, [
    buildFile({ path: 'z.test.ts' }).info,
  ])
  assert.equal(scheduler.tick(), true)
  assert.ok(sink.writes().length > before)
  assert.ok(sink.writes().at(-1)?.includes('0 of 1 files'))
})

const RUN = { root: '/p', projects: [''], startTime: 0, watch: false }
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

test('without a terminal, text written while the stream is full is kept and written on drain', async () => {
  const { sink, reporter } = setup({ live: false })
  await reporter['run:start']?.(RUN, [])
  sink.full = true
  reporter.terminal.passthrough.write('one\n')
  await turn()
  reporter.terminal.passthrough.write('two\n')
  await turn()
  await reporter['run:end']?.({ reason: 'passed', files: [], unhandled: [], durationMs: 5 })
  assert.equal(sink.text(), 'one\n', 'the stream is full: nothing else is written yet')
  sink.drain()
  assert.match(sink.text(), /^one\ntwo\n.*of 0 files {2}0\.0s\n$/)
})

test('text written after run:end goes straight out, on a terminal and without one', async () => {
  for (const live of [true, false]) {
    const { scheduler, sink, reporter } = setup({ live })
    await reporter['run:start']?.(RUN, [])
    scheduler.tick()
    await reporter['run:end']?.({ reason: 'passed', files: [], unhandled: [], durationMs: 5 })
    const before = sink.writes().length
    reporter.terminal.passthrough.write('late teardown\n')
    assert.equal(sink.writes().length, before + 1, `live ${live}`)
    assert.equal(sink.writes().at(-1), 'late teardown\n')
  }
})

test('text written after restore() is not lost, and run:end still writes its lines', async () => {
  const { scheduler, sink, reporter } = setup()
  await reporter['run:start']?.(RUN, [])
  scheduler.tick()
  reporter.terminal.restore()
  reporter.terminal.passthrough.write('from a signal handler\n')
  assert.equal(sink.writes().at(-1), 'from a signal handler\n')
  await reporter['run:end']?.({ reason: 'passed', files: [], unhandled: [], durationMs: 5 })
  assert.match(sink.writes().at(-1) as string, /of 0 files {2}0\.0s\n$/)
})

test('text written before run:start is kept and comes out first', async () => {
  for (const live of [true, false]) {
    const { scheduler, sink, reporter } = setup({ live })
    reporter.terminal.passthrough.write('deprecation notice\n')
    reporter.terminal.passthrough.write('half a li')
    await reporter['run:start']?.(RUN, [])
    if (live) scheduler.tick()
    else await turn()
    assert.ok(sink.text().includes('deprecation notice\n'), `live ${live}`)
    reporter.terminal.passthrough.write('ne\n')
    if (live) scheduler.tick()
    else await turn()
    assert.ok(sink.text().includes('half a line\n'), `the partial line survives, live ${live}`)
  }
})

test('a run after a broken one has a working scheduler and a clean error', async () => {
  const { scheduler, sink, reporter } = setup()
  await reporter['run:start']?.(RUN, [])
  scheduler.tick()
  const write = sink.write.bind(sink)
  sink.write = (chunk) => {
    if (typeof chunk === 'string' && chunk.includes('0 of')) throw new Error('EIO')
    return write(chunk)
  }
  const a = buildFile({ path: 'a.test.ts', tests: [{ path: ['t'] }] })
  await reporter['file:start']?.(a.info, 0)
  scheduler.tick()
  assert.equal(reporter.lastError?.()?.message, 'EIO')
  assert.equal(scheduler.stopped(), true)
  sink.write = write
  await reporter['run:start']?.(RUN, [a.info])
  assert.equal(reporter.lastError?.(), undefined)
  assert.equal(scheduler.stopped(), false)
  assert.equal(scheduler.tick(), true)
  assert.ok(sink.writes().at(-1)?.includes('0 of 1 files'))
})

test('an error on a full stream is kept for the bus and frames stop', async () => {
  const { scheduler, sink, reporter } = setup()
  await reporter['run:start']?.(RUN, [])
  sink.full = true
  scheduler.tick()
  sink.emit('error', new Error('EPIPE'))
  assert.equal(reporter.lastError?.()?.message, 'EPIPE')
  const count = sink.writes().length
  const a = buildFile({ path: 'a.test.ts' })
  await reporter['file:start']?.(a.info, 0)
  scheduler.tick()
  assert.equal(sink.writes().length, count)
  await reporter['run:end']?.({ reason: 'passed', files: [], unhandled: [], durationMs: 5 })
})

test('a frame with nothing changed rebuilds no footer, and no frame drains the finished-file ring', async () => {
  const real = createRunState()
  const calls: Record<string, number> = {}
  const counting = { ...real } as Record<string, unknown>
  for (const [key, value] of Object.entries(real)) {
    if (typeof value !== 'function') continue
    counting[key] = (...args: unknown[]) => {
      calls[key] = (calls[key] ?? 0) + 1
      return (value as (...a: unknown[]) => unknown)(...args)
    }
  }
  const state = counting as unknown as RunState
  const scheduler = manualScheduler()
  const reporter = createLiveReporter(
    {
      stream: recordingSink(),
      live: true,
      colour: false,
      columns: 80,
      glyphs: GLYPHS.emoji,
      scheduler,
    },
    state,
  )
  const a = buildFile({ path: 'a.test.ts' })
  await reporter['run:start']?.(RUN, [a.info])
  await reporter['file:start']?.(a.info, 0)
  await reporter['file:end']?.({ file: a.info, state: 'pass', durationMs: 1, errors: [] })
  scheduler.tick()
  assert.equal(state.busy(), 0)
  const reads = calls.workers ?? 0
  assert.ok(reads > 0)
  scheduler.request()
  assert.equal(scheduler.tick(), true)
  assert.equal(calls.workers ?? 0, reads, 'the footer was not rebuilt')
  await reporter['run:end']?.({ reason: 'passed', files: [], unhandled: [], durationMs: 5 })
  assert.equal(calls.take ?? 0, 0, 'the ring is drained only where it is drawn (Phase 2)')
})
