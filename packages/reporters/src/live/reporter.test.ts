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
    if (broken && chunk.includes('status') === false && chunk.includes('✅'))
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
