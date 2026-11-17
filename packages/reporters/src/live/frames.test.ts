// What the finished files, the error blocks and the end of a run look like through the reporter.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createReporterBus } from '../bus.ts'
import {
  buildFile,
  error,
  FIXTURE_FILES,
  fileInfo,
  playRun,
  resultOf,
  testEndEvent,
} from '../internal/test-support.ts'
import { errorLocation, frameLocation } from '../internal/views/location.ts'
import { createRunState, MAX_FILE_CONSOLE, MAX_FILE_FAILURES } from './model/state.ts'
import { provinoReporter } from './reporter.ts'
import { GLYPHS } from './terminal/glyphs.ts'
import { fakeClock, manualScheduler, recordingSink } from './test-support.ts'

const RUN = { root: '/project', projects: [''], startTime: 0, watch: false } as const

function setup(options: { live?: boolean; silent?: true; columns?: number } = {}) {
  const clock = fakeClock()
  const scheduler = manualScheduler(clock)
  const sink = recordingSink()
  const reporter = provinoReporter({
    stream: sink,
    live: options.live ?? true,
    colour: false,
    columns: options.columns ?? 100,
    glyphs: GLYPHS.emoji,
    hyperlinks: false,
    cwd: '/project',
    readSource: () => Promise.resolve(undefined),
    scheduler,
    ...(options.silent === undefined ? {} : { silent: options.silent }),
  })
  return { clock, scheduler, sink, reporter, bus: createReporterBus([reporter]) }
}

test('the location rule: the error’s own, else the first frame that is no library’s', () => {
  assert.deepEqual(frameLocation('at f (file:///p/a.ts:3:4)'), {
    file: '/p/a.ts',
    line: 3,
    column: 4,
  })
  assert.equal(frameLocation('at nothing here'), undefined)
  assert.deepEqual(
    errorLocation(error('x', { location: { file: 'own.ts', line: 1, column: 2 } })),
    { file: 'own.ts', line: 1, column: 2 },
  )
  const stack = [
    'Error: x',
    '    at lib (/p/node_modules/l/i.js:1:1)',
    '    at user (/p/u.test.ts:7:9)',
  ].join('\n')
  assert.deepEqual(errorLocation(error('x', { stack })), {
    file: '/p/u.test.ts',
    line: 7,
    column: 9,
  })
})

test('a file’s console is dim lines under its line, at most 20, then a count; none under silent', async () => {
  const writes = Array.from({ length: 24 }, (_, i) => ({ text: `line ${i}\n` }))
  const spec = { path: 'noisy.test.ts', tests: [{ path: ['t'], console: writes }] }
  const loud = setup({ live: false })
  await playRun(loud.bus, [spec])
  const lines = loud.sink.text().split('\n')
  assert.equal(lines.filter((line) => /^ {3}line \d+$/.test(line)).length, MAX_FILE_CONSOLE)
  assert.ok(lines.includes('   … 4 more lines'))
  const quiet = setup({ live: false, silent: true })
  await playRun(quiet.bus, [spec])
  assert.ok(!quiet.sink.text().includes('line 0'))
})

test('a file keeps at most 50 failed tests and counts the rest', async () => {
  const tests = Array.from({ length: 60 }, (_, i) => ({
    path: [`t${i}`],
    state: 'fail' as const,
    errors: [error('boom')],
  }))
  const { bus, sink } = setup({ live: false })
  await playRun(bus, [{ path: 'bad.test.ts', tests }])
  const text = sink.text()
  assert.equal(
    text.split('\n').filter((line) => line.startsWith('   ● ')).length,
    MAX_FILE_FAILURES,
  )
  assert.ok(text.includes('… 10 more failed tests in this file'))
  assert.ok(text.includes('💥 60 failed'))
})

test('another reporter’s error is a block above the footer', async () => {
  const { scheduler, sink, reporter, bus } = setup()
  await bus.emit('run:start', RUN, [])
  await bus.emit('error', error('the other reporter broke'), 'reporter')
  scheduler.tick()
  const text = sink.text()
  assert.ok(text.includes('● Reporter error'))
  assert.ok(text.includes('the other reporter broke'))
  assert.ok(text.indexOf('Reporter error') < text.indexOf('0/0 files'))
  void reporter
})

test('an unhandled error names its file', async () => {
  const { scheduler, sink, bus } = setup()
  const file = fileInfo('a.test.ts')
  await bus.emit('run:start', RUN, [file])
  await bus.emit('unhandled', file, {
    type: 'unhandled-error',
    ownerId: null,
    lastTestId: null,
    origin: 'uncaughtException',
    error: error('late'),
    t: 1,
  })
  scheduler.tick()
  assert.ok(sink.text().includes('● Unhandled error in a.test.ts'))
})

test('a run cut by bail clears the files that never end from the footer', async () => {
  const { scheduler, sink, bus } = setup()
  const a = buildFile({ path: 'a.test.ts' })
  const b = buildFile({ path: 'b.test.ts' })
  await bus.emit('run:start', RUN, [a.info, b.info])
  await bus.emit('file:start', a.info, 0)
  await bus.emit('file:start', b.info, 1)
  scheduler.tick()
  assert.ok(sink.text().includes('b.test.ts'))
  await bus.emit('run:end', { reason: 'failed', files: [], unhandled: [], durationMs: 5 })
  const last = sink.writes().at(-1) as string
  assert.ok(last.includes('💥'))
  assert.ok(!last.includes('b.test.ts'), 'no worker line in the last write')
  assert.ok(last.endsWith('\u001b[?25h'))
})

test('the first frame says how many workers will start, and a shard is named', async () => {
  const { scheduler, sink, bus } = setup()
  const a = fileInfo('a.test.ts')
  await bus.emit('run:start', { ...RUN, workers: 8, shard: { index: 2, count: 3 } }, [a])
  scheduler.tick()
  const text = sink.text()
  assert.ok(text.includes('starting 8 workers'))
  assert.ok(text.includes('shard 2/3'))
})

test('several projects: the name goes before the path', async () => {
  const { bus, sink } = setup({ live: false })
  await playRun(bus, [{ path: 'a.test.ts', project: 'server', tests: [{ path: ['t'] }] }])
  assert.ok(sink.text().includes('✅ server a.test.ts · 1 test'))
})

test('the end card of the fixture run: verdict, slowest files, snapshots, failures again', async () => {
  const { bus, sink } = setup({ live: false })
  await playRun(bus, FIXTURE_FILES, { durationMs: 1234 })
  const text = sink.text()
  assert.ok(text.includes('💥 2 failed · 6 passed · 3 skipped · 2 todo · 8 files · 1.23s'))
  assert.ok(text.includes('🐢 slowest: math.test.ts 12ms'))
})

test('the state keeps a failed test with its file until the file ends, then lets it go', () => {
  const state = createRunState()
  const a = fileInfo('a.test.ts')
  state.start([a], 0)
  state.fileStart(a, 0, 1)
  const failure = { title: ['t'], location: null, errors: [error('x')] }
  state.testEnd(a.fileId, 'fail', failure)
  state.console(a.fileId, 'stdout', 'hello')
  assert.equal(state.workers()[0]?.failures.length, 1)
  state.fileEnd({ file: a, state: 'fail', durationMs: 1, errors: [] })
  const [finished] = state.take()
  assert.deepEqual(finished?.failures, [failure])
  assert.equal(finished?.console.length, 1)
  assert.equal(state.running(), 0)
  state.error({ kind: 'error', subject: 'coordinator', errors: [error('e')] })
  assert.equal(state.takeBlocks().length, 1)
  assert.equal(state.takeBlocks().length, 0)
  state.fileStart(a, 0, 2)
  state.finish()
  assert.equal(state.busy(), 0)
  assert.equal(state.running(), 0)
})

test('a handler for a test end builds no string and a failed test is one object', async () => {
  const { bus, reporter } = setup()
  void reporter
  const file = buildFile({
    path: 'a.test.ts',
    tests: [{ path: ['group', 't'], state: 'fail', errors: [error('x')] }],
  })
  await bus.emit('run:start', RUN, [file.info])
  await bus.emit('file:start', file.info, 0)
  const first = file.tests[0]
  assert.ok(first)
  await bus.emit('task:end', first.task, testEndEvent(first.task, resultOf(first.spec)))
  assert.deepEqual(bus.failures(), [])
})
