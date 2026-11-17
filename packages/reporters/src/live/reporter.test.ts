import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Reporter, ReporterBus, ReporterEvents } from '@provino/types'
import { createReporterBus } from '../bus.ts'
import {
  buildFile,
  collectedEvent,
  FIXTURE_FILES,
  FIXTURE_SNAPSHOTS,
  playRun,
  resultOf,
  testEndEvent,
} from '../internal/test-support.ts'
import { createRunState, RING_CAPACITY, type RunState } from './model/state.ts'
import { createTreeStore, type TreeStore } from './model/tree-store.ts'
import {
  createLiveReporter,
  MAX_WORKER_LINES,
  type ProvinoViews,
  provinoReporter,
} from './reporter.ts'
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
    hyperlinks: false,
    cwd: '/project',
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
        hyperlinks: false,
        cwd: '/project',
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
  assert.ok(frame.includes('0/2 files'))
  assert.ok(frame.includes('src/a.test.ts'))
  assert.ok(frame.includes('src/b.test.ts'))
  assert.ok(frame.endsWith(`${ESC}[?2026l`))
  // The rule first, the workers, the bar line at the very bottom (B26, Tyler's layout).
  const rows = frame.slice(0, -`${ESC}[?2026l`.length).split('\n').filter(Boolean)
  assert.match(rows[0] ?? '', /─{20,}$/)
  assert.match(rows[1] ?? '', /src\/a\.test\.ts/)
  assert.match(rows.at(-1) ?? '', /^[█░]+ {2}0\/2 files {2}0% {3}✅ 1 {2}❌ 0 {3}/)
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
  assert.ok(last.includes('0 tests passed in 0 files'))
  assert.ok(last.endsWith(`${ESC}[?25h`))
  assert.ok(last.includes('1.23s'))
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
  assert.match(sink.text(), /💥 .* · 2\.00s\n/)
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
  assert.ok(sink.text().includes('1 test passed in 0 files'))
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
  assert.ok(sink.writes().at(-1)?.includes('0/1 files'))
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
  assert.match(sink.text(), /^one\ntwo\n\n🎉 0 tests passed in 0 files · 5ms\n$/)
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
  assert.match(sink.writes().at(-1) as string, /0 files · 5ms\n$/)
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
    if (typeof chunk === 'string' && chunk.includes(' files ')) throw new Error('EIO')
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
  assert.ok(sink.writes().at(-1)?.includes('0/1 files'))
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
      hyperlinks: false,
      cwd: '/project',
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
  assert.equal(calls.take, 1, 'the frame that drew the file took the ring; the next one left it')
  await reporter['run:end']?.({ reason: 'passed', files: [], unhandled: [], durationMs: 5 })
  assert.equal(calls.take, 2, 'run:end takes what is left once')
})

// B26 Phase 4: the `--tree` and `--map` views.

function viewed(options: { views?: ProvinoViews; live?: boolean; columns?: number } = {}) {
  const clock = fakeClock()
  const scheduler = manualScheduler(clock)
  const sink = recordingSink()
  const built: string[] = []
  const stores: TreeStore[] = []
  const reporter = createLiveReporter(
    {
      stream: sink,
      live: options.live ?? false,
      colour: false,
      columns: options.columns ?? 100,
      glyphs: GLYPHS.emoji,
      hyperlinks: false,
      cwd: '/project',
      scheduler,
      ...(options.views === undefined ? {} : { views: options.views }),
    },
    createRunState(),
    () => {
      built.push('tree-store')
      const store = createTreeStore()
      stores.push(store)
      return store
    },
  )
  return { clock, scheduler, sink, reporter, built, stores }
}

test('without --tree the tree store is never built, and the reporter has no file:collected handler', async () => {
  for (const views of [undefined, {}, { map: true as const }]) {
    const { sink, reporter, built } = viewed(views === undefined ? {} : { views })
    assert.equal(reporter['file:collected'], undefined, JSON.stringify(views))
    await playRun(createReporterBus([reporter]), FIXTURE_FILES, { snapshots: FIXTURE_SNAPSHOTS })
    assert.deepEqual(built, [], `no tree store: ${JSON.stringify(views)}`)
    assert.ok(sink.text().length > 0)
  }
  const { reporter, built } = viewed({ views: { tree: true } })
  assert.equal(typeof reporter['file:collected'], 'function')
  assert.deepEqual(built, ['tree-store'], 'one store per reporter, made when it is')
})

test('the views print nothing unless asked: the same run, byte for byte, with and without views: {}', async () => {
  const plain = viewed()
  const empty = viewed({ views: {} })
  await playRun(createReporterBus([plain.reporter]), FIXTURE_FILES, {
    snapshots: FIXTURE_SNAPSHOTS,
  })
  await playRun(createReporterBus([empty.reporter]), FIXTURE_FILES, {
    snapshots: FIXTURE_SNAPSHOTS,
  })
  assert.equal(empty.sink.text(), plain.sink.text())
})

test('rule 1 with the views on: every handler writes nothing, reads the clock at most once and returns at once', async () => {
  const { scheduler, sink, reporter } = viewed({ views: { tree: true, map: true }, live: true })
  const bus = createReporterBus([guarded(reporter, sink, scheduler)])
  await playRun(bus, FIXTURE_FILES, { snapshots: FIXTURE_SNAPSHOTS })
  assert.deepEqual(bus.failures(), [])
  assert.equal(sink.writes().length, 1, 'run:end is the only write, with no frame ticked')
})

test('rule 1 with --tree: one store call per event, however long the run', async () => {
  const file = buildFile({ path: 'a.test.ts', tests: [{ path: ['t'] }] })
  const first = file.tests[0]
  assert.ok(first)
  const { task } = first
  const event = testEndEvent(task, resultOf({ path: ['t'] }))

  async function calls(events: number): Promise<number> {
    let count = 0
    const real = createTreeStore()
    const counting: TreeStore = {
      collected: (...args) => {
        count++
        real.collected(...args)
      },
      testEnd: (...args) => {
        count++
        real.testEnd(...args)
      },
      suiteFailed: (...args) => {
        count++
        real.suiteFailed(...args)
      },
      compact: (finished) => real.compact(finished),
      held: () => real.held(),
      clear: () => real.clear(),
    }
    const reporter = createLiveReporter(
      {
        stream: recordingSink(),
        live: true,
        colour: false,
        columns: 80,
        glyphs: GLYPHS.emoji,
        hyperlinks: false,
        cwd: '/project',
        scheduler: manualScheduler(),
        views: { tree: true },
      },
      createRunState(),
      () => counting,
    )
    await reporter['run:start']?.({ root: '/p', projects: [''], startTime: 0, watch: false }, [
      file.info,
    ])
    await reporter['file:start']?.(file.info, 0)
    await reporter['file:collected']?.(file.info, collectedEvent(file))
    const before = count
    for (let i = 0; i < events; i++) await reporter['task:end']?.(task, event)
    return count - before
  }

  assert.equal(await calls(1000), 1000)
  assert.equal(await calls(50_000), 50_000)
})

test('--tree prints after the run’s lines and before the end card; --map after the end card', async () => {
  const { sink, reporter } = viewed({ views: { tree: true, map: true } })
  await playRun(createReporterBus([reporter]), FIXTURE_FILES, { snapshots: FIXTURE_SNAPSHOTS })
  const text = sink.text()
  const lastFile = text.indexOf('✅ console.test.ts')
  const tree = text.indexOf('❌ ./ · ')
  const card = text.indexOf('💥 ')
  const map = text.indexOf('🟩 pass  🟥 fail')
  assert.ok(lastFile !== -1 && tree > lastFile, 'the tree is after the file lines')
  assert.ok(card > tree, 'the card is after the tree')
  assert.ok(map > card, 'the map is after the card')
  assert.ok(text.endsWith('\n'))
  // One blank line between each block and the next.
  assert.match(text, /\n\n❌ \.\/ · /)
  assert.match(text, /\n\n💥 /)
  assert.ok(!/\n\n\n/.test(text), 'never two blank lines in a row')
})

test('--tree alone prints no map, and --map alone no tree', async () => {
  const tree = viewed({ views: { tree: true } })
  await playRun(createReporterBus([tree.reporter]), FIXTURE_FILES, {})
  assert.ok(tree.sink.text().includes('├─'))
  assert.ok(!tree.sink.text().includes('🟩 pass'))
  const map = viewed({ views: { map: true } })
  await playRun(createReporterBus([map.reporter]), FIXTURE_FILES, {})
  assert.ok(map.sink.text().includes('🟩 pass  🟥 fail'))
  assert.ok(!map.sink.text().includes('├─'))
})

test('on a terminal the views are part of the last write, before the cursor comes back', async () => {
  const { scheduler, clock, sink, reporter } = viewed({
    views: { tree: true, map: true },
    live: true,
  })
  const bus = createReporterBus([reporter])
  const stepped: ReporterBus = {
    add: (each) => bus.add(each),
    async emit(event, ...args) {
      clock.advance(37)
      await bus.emit(event, ...args)
      if (event === 'file:end') {
        await turn()
        scheduler.tick()
      }
    },
  }
  await playRun(stepped, FIXTURE_FILES, { snapshots: FIXTURE_SNAPSHOTS })
  const last = sink.writes().at(-1) as string
  assert.ok(last.includes('├─ '))
  assert.ok(last.includes('🟩 pass'))
  assert.ok(last.endsWith(`${ESC}[?25h`))
})

test('a run whose files never ended prints no view; a second run starts the views clean', async () => {
  const { sink, reporter } = viewed({ views: { tree: true, map: true } })
  const a = buildFile({ path: 'a.test.ts', tests: [{ path: ['t'] }] })
  await reporter['run:start']?.(RUN, [a.info])
  await reporter['run:end']?.({ reason: 'interrupted', files: [], unhandled: [], durationMs: 5 })
  assert.ok(!sink.text().includes('├─') && !sink.text().includes('🟩'))
  const bus = createReporterBus([reporter])
  await playRun(bus, [{ path: 'x/one.test.ts', tests: [{ path: ['t'] }] }], {})
  const first = sink.text().length
  await playRun(bus, [{ path: 'y/two.test.ts', tests: [{ path: ['t'] }] }], {})
  const second = sink.text().slice(first)
  assert.ok(
    second.includes('y/') && !second.includes('x/'),
    'the second run shows only its own files',
  )
})

test('every file that ended is in the views once, and the stores hold nothing after the run', async () => {
  const { reporter, sink, stores } = viewed({ views: { tree: true, map: true } })
  await playRun(createReporterBus([reporter]), FIXTURE_FILES, {})
  const store = stores[0]
  assert.ok(store)
  assert.equal(store.held(), 0)
  const cells = sink
    .text()
    .split('\n')
    .filter((line) => /^\.\/ +[🟩🟥🟨⬜]+$/u.test(line))
  assert.equal(cells.length, 1)
  assert.equal([...(cells[0]?.matchAll(/[🟩🟥🟨⬜]/gu) ?? [])].length, FIXTURE_FILES.length)
})

test('files the ring had no room for are named under each view, not shown', async () => {
  const { reporter, sink } = viewed({ views: { tree: true, map: true } })
  const files = Array.from(
    { length: RING_CAPACITY + 3 },
    (_, index) => buildFile({ path: `f/${index}.test.ts` }).info,
  )
  await reporter['run:start']?.(RUN, files)
  for (const info of files) {
    await reporter['file:start']?.(info, 0)
    await reporter['file:end']?.({ file: info, state: 'pass', durationMs: 1, errors: [] })
  }
  await reporter['run:end']?.({ reason: 'passed', files: [], unhandled: [], durationMs: 5 })
  const notes = sink
    .text()
    .split('\n')
    .filter((line) => line === '… 3 more files not shown')
  assert.equal(notes.length, 2, 'once under the tree and once under the map')
})
