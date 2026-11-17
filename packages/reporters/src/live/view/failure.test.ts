import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SourceLocation } from '@provino/types'
import { createReporterBus } from '../../bus.ts'
import { buildFile, error, playRun, resultOf, testEndEvent } from '../../internal/test-support.ts'
import { createStyle } from '../../style.ts'
import { provinoReporter } from '../reporter.ts'
import { GLYPHS } from '../terminal/glyphs.ts'
import { fakeClock, manualScheduler, recordingSink } from '../test-support.ts'
import { codeFrameLines, sliceLines, snippetAround } from './code-frame.ts'
import {
  CODE_FRAME_WAIT_MS,
  createSnippetLoader,
  failureLines,
  MAX_CODE_FRAMES,
  MAX_SOURCE_BYTES,
  titleOf,
  whereOf,
} from './failure.ts'

const plain = createStyle(false)
const context = {
  glyphs: GLYPHS.emoji,
  style: plain,
  columns: 120,
  hyperlinks: false,
  cwd: '/project',
}

const at = (file: string, line: number): SourceLocation => ({ file, line, column: 3 })

test('sliceLines reads only the lines asked for, with CRLF trimmed', () => {
  assert.deepEqual(sliceLines('a\r\nb\nc\nd', 2, 3), ['b', 'c'])
  assert.deepEqual(sliceLines('a\nb', 5, 6), [])
  assert.equal(snippetAround('a\nb', 9), undefined)
  assert.deepEqual(snippetAround('1\n2\n3\n4\n5\n6\n7', 4), {
    first: 2,
    lines: ['2', '3', '4', '5', '6'],
  })
  assert.deepEqual(snippetAround('1\n2\n3', 1), { first: 1, lines: ['1', '2', '3'] })
})

test('a code frame has two lines above and below, a marker and a caret under the column', () => {
  const lines = codeFrameLines(
    { first: 8, lines: ['a', 'b', '\tc();', 'd', 'e'] },
    10,
    2,
    80,
    plain,
  )
  assert.deepEqual(lines, [
    '   8 │ a',
    '   9 │ b',
    '> 10 │   c();',
    '     │   ^',
    '  11 │ d',
    '  12 │ e',
  ])
})

test('the 20-read cap: locations past the twentieth get no read', async () => {
  const read: string[] = []
  const loader = createSnippetLoader({
    cwd: '/p',
    read: async (path) => {
      read.push(path)
      return 'x\n'
    },
  })
  const first = Array.from({ length: 15 }, (_, i) => at(`/p/f${i}.ts`, 1))
  const second = Array.from({ length: 15 }, (_, i) => at(`/p/g${i}.ts`, 1))
  await loader.load(first)
  const result = await loader.load(second)
  assert.equal(read.length, MAX_CODE_FRAMES)
  assert.equal(result?.size, 5)
  assert.equal(loader.load([at('/p/h.ts', 1)]), undefined, 'the budget is spent')
  loader.reset()
  assert.ok(loader.load([at('/p/h.ts', 1)]), 'a new run starts over')
})

test('one read per source path, however many failures are in it', async () => {
  const read: string[] = []
  const loader = createSnippetLoader({
    cwd: '/p',
    read: async (path) => {
      read.push(path)
      return 'a\nb\nc\nd\ne\nf\n'
    },
  })
  const found = await loader.load([at('/p/a.ts', 2), at('/p/a.ts', 5), at('b.ts', 1)])
  assert.deepEqual(read.toSorted(), ['/p/a.ts', '/p/b.ts'])
  assert.equal(found?.size, 3)
})

test('a source over 1 MB, an unreadable one and a read that throws give no frame, and never reject', async () => {
  const loader = createSnippetLoader({
    cwd: '/p',
    read: async (path) => {
      if (path.endsWith('big.ts')) return 'x'.repeat(MAX_SOURCE_BYTES + 1)
      if (path.endsWith('gone.ts')) return undefined
      throw new Error('EIO')
    },
  })
  const found = await loader.load([at('/p/big.ts', 1), at('/p/gone.ts', 1), at('/p/boom.ts', 1)])
  assert.equal(found?.size, 0)
})

test('the failure block: title path, error text without its stack, location, then the frame', () => {
  const failure = {
    title: ['cart', 'total', 'applies the discount'],
    location: null,
    errors: [
      error('expect(received).toBe(expected)', {
        stack: 'Error: x\n    at f (/project/a.test.ts:4:5)',
      }),
    ],
  }
  assert.equal(titleOf(failure), 'cart › total › applies the discount')
  assert.deepEqual(whereOf(failure), { file: '/project/a.test.ts', line: 4, column: 5 })
  const lines = failureLines(failure, context, { first: 3, lines: ['a', 'b', 'c'] })
  assert.equal(lines[0], '   ● cart › total › applies the discount')
  assert.equal(lines[1], '     expect(received).toBe(expected)')
  assert.equal(lines[2], '     › a.test.ts:4:5')
  assert.ok(lines.includes('     > 4 │ b'))
  assert.equal(lines.at(-1), '')
  assert.ok(!lines.join('\n').includes('at f'), 'no stack frames: the location says where')
})

test('a link wraps the location where the terminal draws them', () => {
  const failure = { title: ['t'], location: at('/project/a b.ts', 1), errors: [error('boom')] }
  const text = failureLines(failure, { ...context, hyperlinks: true }).join('\n')
  assert.ok(text.includes(']8;;file:///project/a%20b.ts'))
})

function reporterWith(read: (path: string) => Promise<string | undefined>) {
  const clock = fakeClock()
  const scheduler = manualScheduler(clock)
  const sink = recordingSink()
  const reporter = provinoReporter({
    stream: sink,
    live: true,
    colour: false,
    columns: 80,
    glyphs: GLYPHS.emoji,
    hyperlinks: false,
    cwd: '/project',
    readSource: read,
    scheduler,
  })
  return { clock, scheduler, sink, reporter }
}

test('a block waits at most 200 ms for its read, then prints without a frame; the order is kept', async () => {
  const never = new Promise<string | undefined>(() => {})
  const { clock, scheduler, sink, reporter } = reporterWith((path) =>
    path.endsWith('slow.test.ts') ? never : Promise.resolve('a\nb\nc\n'),
  )
  const slow = buildFile({
    path: 'slow.test.ts',
    tests: [
      { path: ['t'], state: 'fail', errors: [error('boom')], location: { line: 2, column: 1 } },
    ],
  })
  const quick = buildFile({ path: 'quick.test.ts', tests: [{ path: ['u'] }] })
  const bus = createReporterBus([reporter])
  await bus.emit('run:start', { root: '/project', projects: [''], startTime: 0, watch: false }, [
    slow.info,
    quick.info,
  ])
  for (const file of [slow, quick]) {
    await bus.emit('file:start', file.info, 0)
    for (const { task, spec } of file.tests) {
      await bus.emit('task:end', task, testEndEvent(task, resultOf(spec)))
    }
    await bus.emit('file:end', file.result)
  }
  scheduler.tick()
  assert.ok(!sink.text().includes('slow.test.ts'), 'the failing file holds the quick one behind it')
  assert.ok(!sink.text().includes('quick.test.ts'))
  clock.advance(CODE_FRAME_WAIT_MS + 1)
  scheduler.request()
  scheduler.tick()
  const text = sink.text()
  assert.ok(
    text.indexOf('slow.test.ts') !== -1 &&
      text.indexOf('slow.test.ts') < text.indexOf('quick.test.ts'),
  )
  assert.ok(!text.includes('│'), 'printed without a code frame')
})

test('without a terminal a read is waited for, and the run end prints what is left without it', async () => {
  const never = new Promise<string | undefined>(() => {})
  const clock = fakeClock()
  const sink = recordingSink()
  const reporter = provinoReporter({
    stream: sink,
    live: false,
    colour: false,
    columns: 80,
    glyphs: GLYPHS.emoji,
    hyperlinks: false,
    cwd: '/project',
    readSource: () => never,
    scheduler: manualScheduler(clock),
  })
  const bus = createReporterBus([reporter])
  await playRun(bus, [
    {
      path: 'a.test.ts',
      tests: [
        { path: ['t'], state: 'fail', errors: [error('boom')], location: { line: 1, column: 1 } },
      ],
    },
  ])
  assert.ok(sink.text().includes('a.test.ts'))
  assert.ok(sink.text().includes('boom'))
})
