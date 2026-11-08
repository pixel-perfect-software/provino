import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type Frame, messageOf, parseStack, userFrameOf } from './stack.ts'

function framesOf(text: string): readonly Frame[] {
  return parseStack(text).flatMap((segment) => segment.frames)
}

test('a frame is an optional function, an async flag and a location', () => {
  assert.deepEqual(framesOf('    at run (/work/a.test.ts:3:4)'), [
    {
      fn: 'run',
      async: false,
      loc: { kind: 'file', path: '/work/a.test.ts', line: '3', col: '4' },
    },
  ])
  assert.deepEqual(framesOf('    at /work/a.test.ts:3:4'), [
    {
      fn: undefined,
      async: false,
      loc: { kind: 'file', path: '/work/a.test.ts', line: '3', col: '4' },
    },
  ])
  assert.deepEqual(framesOf('    at async /work/a.test.ts:3:4'), [
    {
      fn: undefined,
      async: true,
      loc: { kind: 'file', path: '/work/a.test.ts', line: '3', col: '4' },
    },
  ])
  assert.deepEqual(framesOf('    at async Promise.all (index 0)'), [
    { fn: 'Promise.all', async: true, loc: { kind: 'index', index: '0' } },
  ])
})

test('locations that are not files: native, index, and <anonymous> with or without a position', () => {
  const kinds = [
    '    at fn (native)',
    '    at fn (index 12)',
    '    at new Promise (<anonymous>)',
    '    at fn (<anonymous>:2:3)',
    '    at <anonymous>:1:1',
    '    at fn (:1:2)',
  ].map((line) => framesOf(line)[0]?.loc.kind)
  assert.deepEqual(kinds, ['native', 'index', 'anonymous', 'anonymous', 'anonymous', 'anonymous'])
})

test('an eval frame names the innermost place eval was called from, or nothing when unreadable', () => {
  const loc = (line: string) => framesOf(line)[0]?.loc
  assert.deepEqual(loc('    at eval (eval at run (/work/a.test.ts:3:4), <anonymous>:1:1)'), {
    kind: 'eval',
    origin: { kind: 'file', path: '/work/a.test.ts', line: '3', col: '4' },
  })
  assert.deepEqual(
    loc(
      '    at eval (eval at a (eval at b (/work/n.test.ts:5:6), <anonymous>:1:1), <anonymous>:2:2)',
    ),
    { kind: 'eval', origin: { kind: 'file', path: '/work/n.test.ts', line: '5', col: '6' } },
  )
  assert.deepEqual(loc('    at eval (eval at <anonymous> (<anonymous>:1:1), <anonymous>:2:2)'), {
    kind: 'eval',
    origin: { kind: 'anonymous' },
  })
  assert.deepEqual(loc('    at eval (eval at broken, <anonymous>:2:2)'), {
    kind: 'eval',
    origin: undefined,
  })
})

test('text that is not a frame is not one: no location, no indent', () => {
  for (const line of [
    '    at foo bar baz',
    '    at fn (not a location)',
    '    at fn (/a.ts:1)',
    '    at',
    '  at',
    'at /a.ts:1:2',
  ]) {
    assert.deepEqual(framesOf(line), [], line)
  }
})

test('only the frames that end a segment are its stack', () => {
  const text = [
    'Error: x',
    '  at fnA (/app/a.js:10:5)',
    'y"',
    '    at one (/work/a.test.ts:1:1)',
    '    at two (/work/b.test.ts:2:2)',
    '',
  ].join('\n')
  const [segment, ...rest] = parseStack(text)
  assert.equal(rest.length, 0)
  assert.deepEqual(segment?.lines, ['Error: x', '  at fnA (/app/a.js:10:5)', 'y"', ''])
  assert.deepEqual(
    segment?.frames.map((frame) => frame.fn),
    ['one', 'two'],
  )
})

test('a cause line starts a new segment, each with its own stack', () => {
  const text = [
    'Error: outer',
    '    at a (/work/a.test.ts:1:1)',
    '',
    '[cause]: Error: inner',
    '    at b (/work/b.test.ts:2:2)',
    'Caused by: Error: root',
    '    at c (/work/c.test.ts:3:3)',
  ].join('\n')
  const segments = parseStack(text)
  assert.deepEqual(
    segments.map((s) => s.frames.map((f) => f.fn)),
    [['a'], ['b'], ['c']],
  )
  assert.equal(
    messageOf(segments),
    ['Error: outer', '', '[cause]: Error: inner', 'Caused by: Error: root'].join('\n'),
  )
})

test('a segment that is only a stack leaves no blank line behind in the message', () => {
  const segments = parseStack('    at a (/work/a.test.ts:1:1)\n[cause]: Error: inner')
  assert.equal(messageOf(segments), '[cause]: Error: inner')
})

test("Jest's toThrow: the received error's stack, indented apart, is neither message nor stack", () => {
  // The shape of Jest 30.5's failure text (recorded in sample/__recorded__/jest.raw.json).
  const text = [
    'Error: expect(received).toThrow(expected)',
    '',
    'Received message:   "kaboom"',
    '',
    '      at fail.test.ts:12:13',
    '      at Object.<anonymous> (../../node_modules/expect/build/index.js:1824:9)',
    '      at Object.toThrow (fail.test.ts:13:8)',
    '    at Object.toThrow (/work/fail.test.ts:13:8)',
    '    at callAsyncCircusFn (/repo/node_modules/jest-circus/build/x.js:1:1)',
  ].join('\n')
  const segments = parseStack(text)
  assert.equal(
    messageOf(segments),
    'Error: expect(received).toThrow(expected)\n\nReceived message:   "kaboom"\n',
  )
  assert.equal(segments[0]?.frames.length, 2)
  assert.equal(userFrameOf(segments), '/work/fail.test.ts:13:8')
})

test('a frame-like line printed as data above the stack, in a failure that is not toThrow, is kept', () => {
  const text = [
    'Error: the log was not empty',
    '      at somewhere (/work/log.txt:1:1)',
    '    at Object.<anonymous> (/work/a.test.ts:3:4)',
  ].join('\n')
  const segments = parseStack(text)
  assert.equal(
    messageOf(segments),
    'Error: the log was not empty\n      at somewhere (/work/log.txt:1:1)',
  )
  assert.equal(segments[0]?.frames.length, 1)
  assert.equal(userFrameOf(segments), '/work/a.test.ts:3:4')
})

test("Jest's bare .not.toThrow() prints its received error under `Error message:`", () => {
  const text = [
    'Error: expect(received).not.toThrow()',
    '',
    'Error message: "bad input"',
    '',
    '      at /work/throws.test.ts:15:9',
    '    at Object.toThrow (/work/throws.test.ts:48:31)',
  ].join('\n')
  const segments = parseStack(text)
  assert.equal(
    messageOf(segments),
    'Error: expect(received).not.toThrow()\n\nError message: "bad input"\n',
  )
  assert.equal(userFrameOf(segments), '/work/throws.test.ts:48:31')
})

test("every toThrow layout ends with the received error's stack: `Expected message: not`, a multi-line message", () => {
  for (const middle of [
    ['Expected message: not "x"'],
    ['Received message:   "first line', 'second line"'],
  ]) {
    const text = [
      'Error: expect(received).not.toThrow(expected)',
      '',
      ...middle,
      '',
      '      at /work/throws.test.ts:15:9',
      '    at Object.toThrow (/work/throws.test.ts:52:31)',
    ].join('\n')
    const segments = parseStack(text)
    assert.equal(
      messageOf(segments),
      ['Error: expect(received).not.toThrow(expected)', '', ...middle, ''].join('\n'),
    )
    assert.equal(userFrameOf(segments), '/work/throws.test.ts:52:31')
  }
})

test('frames indented alike are one stack, whatever their indent', () => {
  const text = 'Error: x\n      at a (/work/a.test.ts:1:1)\n      at b (/work/b.test.ts:2:2)'
  const segments = parseStack(text)
  assert.equal(segments[0]?.frames.length, 2)
  assert.equal(userFrameOf(segments), '/work/a.test.ts:1:1')
})

test('text with no frames is its own message, line for line', () => {
  for (const text of ['', 'one', 'one\n', '\n\ntwo\n\n', 'a\r\nb']) {
    assert.equal(messageOf(parseStack(text)), text)
  }
})

test('the user frame is the first frame in a file that is not Node’s, a dependency’s or a runner’s', () => {
  const userFrame = (text: string) => userFrameOf(parseStack(text))
  assert.equal(
    userFrame(
      [
        'Error: x',
        '    at a (node:internal/process/task_queues:105:5)',
        '    at b (/repo/node_modules/jest-circus/build/x.js:1:1)',
        '    at c (file:///repo/vitest/dist/run.js:1:1)',
        '    at d (<anonymous>)',
        '    at e (/work/fixture/a.test.ts:7:23)',
        '    at f (/work/fixture/b.test.ts:1:1)',
      ].join('\n'),
    ),
    '/work/fixture/a.test.ts:7:23',
  )
  assert.equal(userFrame('Error: x\n    at e (<root>/a.test.ts:7:23)'), '<root>/a.test.ts:7:23')
  assert.equal(userFrame('Error: x\n    at node:fs:441:20'), undefined)
  assert.equal(userFrame('no frames'), undefined)
})

test('a path that is not rooted is made <root>-relative; a path, a drive or a URL is kept', () => {
  const userFrame = (location: string) =>
    userFrameOf(parseStack(`Error: x\n    at run (${location})`))
  assert.equal(userFrame('a.test.ts:7:23'), '<root>/a.test.ts:7:23')
  assert.equal(userFrame('sub/a.test.ts:7:23'), '<root>/sub/a.test.ts:7:23')
  assert.equal(userFrame('/abs/a.test.ts:7:23'), '/abs/a.test.ts:7:23')
  assert.equal(userFrame('C:\\work\\a.test.ts:7:23'), 'C:\\work\\a.test.ts:7:23')
  assert.equal(userFrame('https://host/a.js:7:23'), 'https://host/a.js:7:23')
})

test('an eval frame is the user’s when the file that called eval is', () => {
  const evalFrame = '    at eval (eval at run (/work/a.test.ts:3:4), <anonymous>:1:1)'
  assert.equal(userFrameOf(parseStack(`Error: x\n${evalFrame}`)), '/work/a.test.ts:3:4')
  const dependency = '    at eval (eval at run (/repo/node_modules/x/y.js:3:4), <anonymous>:1:1)'
  assert.equal(userFrameOf(parseStack(`Error: x\n${dependency}`)), undefined)
})

test('a very long line with no closing parenthesis is read in linear time', {
  timeout: 1_000,
}, () => {
  const line = `    at ${'a (b '.repeat(18_000)}`
  const segments = parseStack(`Error: x\n${line}`)
  assert.equal(segments[0]?.frames.length, 0)
  assert.equal(messageOf(segments), `Error: x\n${line}`)
})
