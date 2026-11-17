// What the code review of the `provino` reporter found, each pinned (B26 Phase 2).
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getHeapStatistics, setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { createReporterBus } from '../bus.ts'
import {
  buildFile,
  error,
  fileInfo,
  playRun,
  resultOf,
  testEndEvent,
} from '../internal/test-support.ts'
import { createStyle } from '../style.ts'
import { boundError, MAX_ERROR_STRING } from './model/bound.ts'
import { createRunState } from './model/state.ts'
import { createLiveReporter, provinoReporter } from './reporter.ts'
import { GLYPHS } from './terminal/glyphs.ts'
import { cleanText } from './terminal/sanitize.ts'
import { displayWidth } from './terminal/width.ts'
import { fakeClock, manualScheduler, recordingSink } from './test-support.ts'
import {
  createSnippetLoader,
  displayFile,
  failureLines,
  failureSummaryLine,
  MAX_SOURCE_BYTES,
  MAX_STACK_FRAMES,
  placeOf,
  readSourceCapped,
} from './view/failure.ts'
import { consoleLines, fileLine } from './view/file-line.ts'

const ESC = String.fromCharCode(27)
const RUN = { root: '/project', projects: [''], startTime: 0, watch: false } as const

function setup(
  options: {
    live?: boolean
    colour?: boolean
    columns?: number
    noStackTrace?: true
    readSource?: (path: string) => Promise<string | undefined>
  } = {},
) {
  const clock = fakeClock()
  const scheduler = manualScheduler(clock)
  const sink = recordingSink()
  const reporter = provinoReporter({
    stream: sink,
    live: options.live ?? false,
    colour: options.colour ?? false,
    columns: options.columns ?? 100,
    glyphs: GLYPHS.emoji,
    hyperlinks: false,
    cwd: '/project',
    readSource: options.readSource ?? (() => Promise.resolve(undefined)),
    scheduler,
    timers: clock.timers,
    ...(options.noStackTrace === undefined ? {} : { noStackTrace: options.noStackTrace }),
  })
  return { clock, scheduler, sink, reporter, bus: createReporterBus([reporter]) }
}

const located = error('expect(received).toBe(expected)', {
  stack: ['Error: x', '    at Object.<anonymous> (/project/a.test.ts:3:15)'].join('\n'),
  location: { file: '/project/a.test.ts', line: 3, column: 15 },
})

// 1
test('1: errors past the 200 a frame keeps are counted, and the count prints', async () => {
  const { scheduler, sink, bus } = setup({ live: true })
  await bus.emit('run:start', RUN, [])
  for (let i = 0; i < 205; i++) await bus.emit('error', error(`e${i}`), 'coordinator')
  scheduler.tick()
  assert.ok(sink.text().includes('… 5 more errors'))
})

// 2
test('2: noStackTrace shows no location, no code frame and no location in the end list', async () => {
  const { bus, sink } = setup({ noStackTrace: true })
  await playRun(bus, [
    {
      path: 'a.test.ts',
      tests: [
        {
          path: ['t'],
          state: 'fail',
          errors: [located],
          location: { line: 3, column: 15 },
        },
      ],
    },
  ])
  const text = sink.text()
  assert.ok(text.includes('● t'))
  assert.ok(!text.includes(':3:15'), text)
  assert.ok(!text.includes('›'))
})

// 3
test('3: a cursor move, a clear and a bare carriage return in console text never reach the output', async () => {
  const { bus, sink } = setup()
  await playRun(bus, [
    {
      path: 'a.test.ts',
      tests: [
        {
          path: ['t\u001b[2J'],
          state: 'fail',
          errors: [error('bad\u001b[1A\rtext\u0007')],
          console: [{ text: `up${ESC}[2J${ESC}[1Adown\rback\n` }],
        },
      ],
    },
  ])
  const text = sink.text()
  assert.ok(!text.includes(ESC), 'no escape at all without colour')
  assert.ok(!text.includes('\r'))
  assert.ok(!text.includes('\u0007'))
  assert.ok(text.includes('updownback'))
  assert.ok(text.includes('badtext'))
})

test('3: colour keeps the SGR codes (a diff stays coloured) and closes each line that has them; the rest still goes', () => {
  const diff = `${ESC}[31m- old${ESC}[39m\n${ESC}[32m+ new${ESC}[39m ${ESC}[2J${ESC}[41mbleed`
  assert.equal(
    cleanText(diff, true),
    `${ESC}[31m- old${ESC}[39m${ESC}[0m\n${ESC}[32m+ new${ESC}[39m ${ESC}[41mbleed${ESC}[0m`,
  )
  assert.equal(cleanText(diff, false), '- old\n+ new bleed')
  assert.equal(cleanText('a\tb\r\nc\rd', true), 'a\tb\nccd'.replace('ccd', 'cd'))
  assert.equal(cleanText('plain', true), 'plain')
  assert.equal(cleanText(`x${ESC}]0;title\u0007y${ESC}]8;;https://e.x${ESC}\\z`, true), 'xyz')
})

test('3: width is measured on the cleaned text: a line of escapes is not cut for the room they would take', () => {
  const style = createStyle(false)
  const noisy = `${`${ESC}[2J`.repeat(40)}visible text`
  const [line] = consoleLines([{ stream: 'stdout', text: noisy }], 0, 30, style, false)
  assert.equal(line, '   visible text')
  const wide = 'x'.repeat(100)
  const [cut] = consoleLines([{ stream: 'stdout', text: wide }], 0, 30, style, false)
  assert.ok(displayWidth(cut as string) <= 29)
})

// 4
test('4: a failure block and its summary line use the place worked out once, and never read the stack again', () => {
  const failure = {
    title: ['t'],
    location: null,
    errors: [
      {
        ...error('boom'),
        get stack(): string {
          throw new Error('the stack was read again')
        },
      },
    ],
  }
  const place = { where: { file: '/project/a.ts', line: 1, column: 1 }, frames: [], framesMore: 0 }
  const context = {
    glyphs: GLYPHS.emoji,
    style: createStyle(false),
    columns: 100,
    hyperlinks: false,
    cwd: '/project',
    colour: false,
  }
  assert.ok(failureLines(failure, place, context).join('\n').includes('a.ts:1:1'))
  assert.ok(failureSummaryLine(failure, place, context).includes('a.ts:1:1'))
})

// 5
test('5: what a running file keeps of an error is bounded by size: a multi-MB message is cut and not retained', async () => {
  const state = createRunState()
  const reporter = createLiveReporter(
    {
      stream: recordingSink(),
      live: false,
      colour: false,
      columns: 80,
      glyphs: GLYPHS.emoji,
      hyperlinks: false,
      cwd: '/project',
      scheduler: manualScheduler(),
    },
    state,
  )
  const file = buildFile({
    path: 'big.test.ts',
    tests: [{ path: ['t'], state: 'fail', errors: [error('x')] }],
  })
  const first = file.tests[0]
  assert.ok(first)
  await reporter['run:start']?.(RUN, [file.info])
  await reporter['file:start']?.(file.info, 0)

  setFlagsFromString('--expose-gc')
  const gc = runInNewContext('gc') as () => void
  const used = (): number => {
    gc()
    gc()
    return getHeapStatistics().used_heap_size
  }
  const before = used()
  await (async () => {
    // The only references to the 8 MB message are in this scope and the event.
    const huge = error('m'.repeat(8 * 1024 * 1024), {
      stack: `Error: s\n${'    at f (/project/a.ts:1:1)\n'.repeat(300_000)}`,
    })
    await reporter['task:end']?.(
      first.task,
      testEndEvent(first.task, { ...resultOf(first.spec), errors: [huge] }),
    )
    await reporter['file:end']?.({
      file: file.info,
      state: 'fail',
      durationMs: 1,
      errors: [huge],
    })
  })()
  const retained = used() - before
  const [finished] = state.take()
  const kept = finished?.failures[0]?.errors[0]
  assert.ok((kept?.message.length ?? Number.POSITIVE_INFINITY) <= MAX_ERROR_STRING)
  assert.ok((kept?.stack?.length ?? Number.POSITIVE_INFINITY) <= MAX_ERROR_STRING)
  assert.ok(
    (finished?.result.errors[0]?.message.length ?? Number.POSITIVE_INFINITY) <= MAX_ERROR_STRING,
  )
  assert.ok(retained < 1024 * 1024, `retained ${retained} bytes after the 8 MB message`)
})

test('5: bounded errors keep what a frame reads and stop at three levels', () => {
  let chain = error('deep')
  for (let i = 0; i < 6; i++) chain = { ...error(`level ${i}`), cause: chain }
  const bounded = boundError({ ...chain, code: 'E1', location: { file: 'f', line: 1, column: 1 } })
  assert.equal(bounded.code, 'E1')
  assert.deepEqual(bounded.location, { file: 'f', line: 1, column: 1 })
  let depth = 0
  for (let each = bounded.cause; each !== undefined; each = each.cause) depth++
  assert.equal(depth, 3)
})

// 6
test('6: a finished file’s line is never wider than the terminal leaves room for', () => {
  const style = createStyle(false)
  const input = {
    path: 'packages/some/very/deeply/nested/component.with.long.name.test.tsx',
    project: 'a-project',
    state: 'fail' as const,
    tests: 1204,
    failed: 3,
    skipped: 0,
    durationMs: 12_345,
  }
  for (const set of [GLYPHS.emoji, GLYPHS.ascii]) {
    for (const columns of [14, 20, 28, 40, 60, 120]) {
      const line = fileLine(input, columns, set, style)
      assert.ok(displayWidth(line) <= columns - 1, `${columns}: ${displayWidth(line)} ${line}`)
    }
  }
  const narrow = fileLine(input, 40, GLYPHS.ascii, style)
  assert.match(narrow, /^x .*test\.tsx · 12\.3s$|^x …/)
})

// 7
test('7: without a terminal a stuck read holds the later files for 200 ms, then they print without the frame', async () => {
  const never = new Promise<string | undefined>(() => {})
  const { clock, sink, bus } = setup({ readSource: () => never })
  const slow = buildFile({
    path: 'slow.test.ts',
    tests: [{ path: ['t'], state: 'fail', errors: [located], location: { line: 3, column: 15 } }],
  })
  const quick = buildFile({ path: 'quick.test.ts', tests: [{ path: ['u'] }] })
  await bus.emit('run:start', RUN, [slow.info, quick.info])
  for (const file of [slow, quick]) {
    await bus.emit('file:start', file.info, 0)
    for (const { task, spec } of file.tests) {
      await bus.emit('task:end', task, testEndEvent(task, resultOf(spec)))
    }
    await bus.emit('file:end', file.result)
  }
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(sink.text(), '', 'held while the read is out')
  clock.advance(199)
  assert.equal(sink.text(), '')
  clock.advance(2)
  const text = sink.text()
  assert.ok(text.includes('slow.test.ts') && text.includes('quick.test.ts'), text)
  assert.ok(text.indexOf('slow.test.ts') < text.indexOf('quick.test.ts'))
  assert.equal(clock.pending(), 0, 'no timer is left')
})

// 8
test('8: the cap is in bytes, not characters', async () => {
  const loader = createSnippetLoader({
    cwd: '/p',
    read: async () => 'é'.repeat(600_000),
  })
  const found = await loader.load([{ file: '/p/a.ts', line: 1, column: 1 }])
  assert.equal(found?.size, 0, '600,000 characters are 1.2 MB')
})

test('8: a file is read through a handle: at the cap it is read, over it or not a regular file it is not', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provino-source-'))
  try {
    await writeFile(join(dir, 'ok.ts'), `${'a'.repeat(MAX_SOURCE_BYTES - 1)}\n`)
    await writeFile(join(dir, 'big.ts'), 'a'.repeat(MAX_SOURCE_BYTES + 1))
    await mkdir(join(dir, 'dir.ts'))
    assert.equal((await readSourceCapped(join(dir, 'ok.ts')))?.length, MAX_SOURCE_BYTES)
    assert.equal(await readSourceCapped(join(dir, 'big.ts')), undefined)
    assert.equal(await readSourceCapped(join(dir, 'dir.ts')), undefined)
    assert.equal(await readSourceCapped(join(dir, 'missing.ts')), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// 9
test('9: a console write that comes after its file ended is counted, and the end card says so', async () => {
  const state = createRunState()
  const a = fileInfo('a.test.ts')
  state.start([a], 0)
  state.fileStart(a, 0, 1)
  state.console(a.fileId, 'stdout', 'in time')
  state.fileEnd({ file: a, state: 'pass', durationMs: 1, errors: [] })
  state.console(a.fileId, 'stderr', 'too late')
  state.console(fileInfo('never.test.ts').fileId, 'stdout', 'never started')
  assert.equal(state.lateConsole(), 2)

  const { bus, sink } = setup()
  const file = buildFile({ path: 'b.test.ts', tests: [{ path: ['t'] }] })
  await bus.emit('run:start', RUN, [file.info])
  await bus.emit('file:start', file.info, 0)
  await bus.emit('file:end', file.result)
  await bus.emit('console', file.info, {
    type: 'console',
    taskId: null,
    stream: 'stderr',
    level: 'warn',
    text: 'after',
    origin: null,
    t: 1,
  })
  await bus.emit('run:end', {
    reason: 'passed',
    files: [file.result],
    unhandled: [],
    durationMs: 5,
  })
  assert.ok(sink.text().includes('1 console write came after their file ended'))
})

// 10
test('10: a directory whose name starts with two dots is inside the root', () => {
  assert.equal(displayFile('/project', '/project/..generated/a.ts'), '..generated/a.ts')
  assert.equal(displayFile('/project', '/project/src/a.ts'), 'src/a.ts')
  assert.equal(displayFile('/project', '/other/a.ts'), '/other/a.ts')
  assert.equal(displayFile('/project', '/project/../x/a.ts'), '/project/../x/a.ts')
})

// 11
const STACK = [
  'Error: deep',
  '    at inner (/project/src/deep/inner.ts:10:5)',
  '    at middle (/project/src/deep/middle.ts:20:6)',
  '    at node:internal/process/task_queues:1:1',
  '    at lib (/project/node_modules/lib/index.js:1:1)',
  '    at outer (file:///project/src/outer.ts:30:7)',
  '    at a1 (/project/src/a1.ts:1:1)',
  '    at a2 (/project/src/a2.ts:2:1)',
  '    at a3 (/project/src/a3.ts:3:1)',
  '    at a4 (/project/src/a4.ts:4:1)',
  '    at a5 (/project/src/a5.ts:5:1)',
].join('\n')

test('11: the located frame and up to five more user frames, paths relative, a count past five', () => {
  const failure = { title: ['t'], location: null, errors: [error('deep', { stack: STACK })] }
  const place = placeOf(failure, '/project')
  assert.deepEqual(place.where, { file: '/project/src/deep/inner.ts', line: 10, column: 5 })
  assert.equal(MAX_STACK_FRAMES, 5)
  assert.deepEqual(place.frames, [
    'at middle (src/deep/middle.ts:20:6)',
    'at outer (src/outer.ts:30:7)',
    'at a1 (src/a1.ts:1:1)',
    'at a2 (src/a2.ts:2:1)',
    'at a3 (src/a3.ts:3:1)',
  ])
  assert.equal(place.framesMore, 2)
  const context = {
    glyphs: GLYPHS.emoji,
    style: createStyle(false),
    columns: 100,
    hyperlinks: false,
    cwd: '/project',
    colour: false,
  }
  const lines = failureLines(failure, place, context, { first: 9, lines: ['a', 'b', 'c'] })
  const at = lines.findIndex((line) => line.includes('at middle'))
  assert.ok(
    at > lines.findIndex((line) => line.includes('> 10 │ b')),
    'the chain is under the code frame',
  )
  assert.equal(lines[at + 5], '     … 2 more')
  assert.ok(!lines.join('\n').includes('node_modules'))
  assert.ok(!lines.join('\n').includes('node:internal'))
})

test('11: an error’s own location is not repeated, and every user frame follows it', () => {
  const failure = {
    title: ['t'],
    location: null,
    errors: [
      error('x', { stack: STACK, location: { file: '/project/own.ts', line: 1, column: 1 } }),
    ],
  }
  const place = placeOf(failure, '/project')
  assert.equal(place.where?.file, '/project/own.ts')
  assert.equal(place.frames[0], 'at inner (src/deep/inner.ts:10:5)')
})

// Found by B26 Phase 3: a run in band announces the next file on the same worker before the last
// one has ended, and the first file printed `0 tests`.
test('a file keeps its counts when the next file starts on its worker before it ends (in band)', async () => {
  const { sink, bus } = setup()
  const first = buildFile({ path: 'first.test.ts', tests: [{ path: ['a'] }, { path: ['b'] }] })
  const second = buildFile({ path: 'second.test.ts', tests: [{ path: ['c'] }] })
  await bus.emit('run:start', RUN, [first.info, second.info])
  await bus.emit('file:start', first.info, 1)
  for (const { task, spec } of first.tests) {
    await bus.emit('task:end', task, testEndEvent(task, resultOf(spec)))
  }
  await bus.emit('file:start', second.info, 1)
  await bus.emit('file:end', first.result)
  for (const { task, spec } of second.tests) {
    await bus.emit('task:end', task, testEndEvent(task, resultOf(spec)))
  }
  await bus.emit('file:end', second.result)
  await new Promise((resolve) => setImmediate(resolve))
  const text = sink.text()
  assert.match(text, /^✅ first\.test\.ts · 2 tests · /m)
  assert.match(text, /^✅ second\.test\.ts · 1 test · /m)
})
