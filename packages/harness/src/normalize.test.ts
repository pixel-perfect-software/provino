import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createNormalizer,
  type NormalizeContext,
  normalizeError,
  normalizeText,
  rules,
  testKey,
} from './normalize.ts'

const ctx: NormalizeContext = { rootDir: '/work/fixture' }

function rule(id: string): (s: string, c?: NormalizeContext) => string {
  const found = rules.find((r) => r.id === id)
  assert.ok(found, `no rule ${id}`)
  return (s, c = ctx) => found.apply(s, c)
}

test('there are nine rules, in the order of Track 12 F2', () => {
  assert.deepEqual(
    rules.map((r) => r.id),
    [
      'ansi',
      'crlf',
      'file-url',
      'root',
      'windows-separators',
      'code-frames',
      'durations',
      'placeholders',
      'stack',
    ],
  )
})

test('ansi: strips colour codes and hyperlinks', () => {
  const ansi = rule('ansi')
  assert.equal(ansi('\u001b[31mred\u001b[39m and \u001b[1m\u001b[22mplain'), 'red and plain')
  assert.equal(ansi('\u001b]8;;https://example.com\u0007label\u001b]8;;\u0007'), 'label')
  assert.equal(ansi('no codes'), 'no codes')
})

test('crlf: turns CRLF into LF and leaves a lone CR', () => {
  const crlf = rule('crlf')
  assert.equal(crlf('a\r\nb\r\n'), 'a\nb\n')
  assert.equal(crlf('progress\rdone'), 'progress\rdone')
})

test('file-url: turns file:// URLs into paths', () => {
  const fileUrl = rule('file-url')
  assert.equal(fileUrl('at file:///work/fixture/a.test.ts:9:26'), 'at /work/fixture/a.test.ts:9:26')
  assert.equal(fileUrl('(file:///work/with%20space/a.ts:1:2)'), '(/work/with space/a.ts:1:2)')
  assert.equal(fileUrl('file:///C:/work/a.ts:1:2'), 'C:/work/a.ts:1:2')
  assert.equal(fileUrl('file:///bad%zz/a.ts'), '/bad%zz/a.ts')
})

test('file-url: accepts one, two or three slashes after file:', () => {
  const fileUrl = rule('file-url')
  // Jest prints transform-failure frames with a single slash.
  assert.equal(
    fileUrl('at strip (file:/Users/me/proj/jest-transform.ts:12:39)'),
    'at strip (/Users/me/proj/jest-transform.ts:12:39)',
  )
  assert.equal(fileUrl('file:/C:/work/a.ts:1:2'), 'C:/work/a.ts:1:2')
  assert.equal(fileUrl('file:////srv/a.ts'), 'file:////srv/a.ts')
  assert.equal(fileUrl('see file: /work/x'), 'see file: /work/x')
  assert.equal(fileUrl('profile:///x/a.ts'), 'profile:///x/a.ts')
})

test('root: replaces the root and extra roots with <root>', () => {
  const root = rule('root')
  assert.equal(root('/work/fixture/a.test.ts:1:2'), '<root>/a.test.ts:1:2')
  assert.equal(
    root('/ws/pkg/x.ts and /work/fixture/y.ts', { rootDir: '/work/fixture', extraRoots: ['/ws'] }),
    '<root>/pkg/x.ts and <root>/y.ts',
  )
  assert.equal(root('in /work/fixture.'), 'in <root>.')
  assert.equal(root('/work/fixture/a', { rootDir: '/work/fixture/' }), '<root>/a')
})

test('root: leaves a sibling directory with the same prefix alone', () => {
  const root = rule('root')
  assert.equal(root('/work/fixture2/a.ts'), '/work/fixture2/a.ts')
  assert.equal(root('/work/fixture-old/a.ts'), '/work/fixture-old/a.ts')
})

test('root: needs a boundary on the left, so a longer path that contains the root is left alone', () => {
  const root = rule('root')
  assert.equal(root('/home/me/work/fixture/a.ts'), '/home/me/work/fixture/a.ts')
  assert.equal(root('/usr/lib/app/x.ts', { rootDir: '/app' }), '/usr/lib/app/x.ts')
  assert.equal(root('../work/fixture/a.ts'), '../work/fixture/a.ts')
  assert.equal(root('open (/work/fixture/a.ts)'), 'open (<root>/a.ts)')
  assert.equal(root("cwd='/work/fixture'"), "cwd='<root>'")
})

test('root: needs an allow-listed character on the right', () => {
  const root = rule('root')
  assert.equal(root('/work/fixture@1/a'), '/work/fixture@1/a')
  assert.equal(root('/work/fixture copy/a'), '/work/fixture copy/a')
  assert.equal(root('/work/fixture.d/a'), '/work/fixture.d/a')
  for (const [input, expected] of [
    ['/work/fixture', '<root>'],
    ['/work/fixture/a', '<root>/a'],
    ['/work/fixture\\a', '<root>\\a'],
    ['in /work/fixture and /x', 'in <root> and /x'],
    ["'/work/fixture'", "'<root>'"],
    ['/work/fixture:12:3', '<root>:12:3'],
    ['(/work/fixture)', '(<root>)'],
    ['/work/fixture, /work/fixture;', '<root>, <root>;'],
    ['in /work/fixture.', 'in <root>.'],
    ['/work/fixture.\nnext', '<root>.\nnext'],
  ] as const) {
    assert.equal(root(input), expected, input)
  }
})

test('root: a nested extra root wins over its parent', () => {
  const root = rule('root')
  assert.equal(
    root('/work/fixture/pkg/a.ts', { rootDir: '/work/fixture', extraRoots: ['/work/fixture/pkg'] }),
    '<root>/a.ts',
  )
})

test('windows-separators: converts paths after <root> or a drive letter', () => {
  const windows = rule('windows-separators')
  const onWindows: NormalizeContext = { rootDir: 'C:\\work\\fixture' }
  assert.equal(windows('<root>\\src\\a.test.ts:9:26', onWindows), '<root>/src/a.test.ts:9:26')
  assert.equal(
    windows('<root>\\src\\a.ts', { rootDir: '/work/fixture', extraRoots: ['\\\\server\\share'] }),
    '<root>/src/a.ts',
  )
  assert.equal(windows('at C:\\Users\\me\\a.ts:1:2'), 'at C:/Users/me/a.ts:1:2')
})

test('windows-separators: <root> followed by an escape stays untouched on a POSIX root', () => {
  const windows = rule('windows-separators')
  assert.equal(windows("expected '<root>\\n' to be 'x'"), "expected '<root>\\n' to be 'x'")
  assert.equal(windows('<root>\\tab'), '<root>\\tab')
  assert.equal(
    normalizeText("expected '/work/fixture\\n' to be 'x'", ctx),
    "expected '<root>\\n' to be 'x'",
  )
})

test('windows-separators: keeps backslashes that are not paths', () => {
  const windows = rule('windows-separators')
  assert.equal(windows('"foo:\\nbar"'), '"foo:\\nbar"')
  assert.equal(windows('regex \\d+\\s'), 'regex \\d+\\s')
})

test('windows-separators: a Windows root becomes <root> and forward slashes end to end', () => {
  const out = normalizeText('C:\\work\\fixture\\src\\a.test.ts:1:2', {
    rootDir: 'C:\\work\\fixture',
  })
  assert.equal(out, '<root>/src/a.test.ts:1:2')
})

test('code-frames: removes a Jest code frame and its caret line', () => {
  const frame = rule('code-frames')
  const text = [
    'boom',
    '',
    '   7 |   it(',
    ' > 8 |     throw new Error()',
    '     |           ^',
    '   9 |   })',
    '',
    'next',
  ].join('\n')
  assert.equal(frame(text), 'boom\n\n\nnext')
})

test('code-frames: keeps numbered rows that are not a code frame', () => {
  const frame = rule('code-frames')
  const table = 'Received:\n1 | one\n2 | two'
  assert.equal(frame(table), table)
  assert.equal(frame('plain text'), 'plain text')
})

test('durations: replaces the measured times runners print', () => {
  const durations = rule('durations')
  assert.equal(durations('✓ passes (12 ms)'), '✓ passes (<dur>)')
  assert.equal(durations('slow (1.2 s) and quick (3µs)'), 'slow (<dur>) and quick (<dur>)')
  assert.equal(durations('Time:        1.234 s'), 'Time:        <dur>')
  assert.equal(
    durations('Tests: 1 passed\nTime: 1.234 s, estimated 2 s\nRan all'),
    'Tests: 1 passed\nTime: <dur>\nRan all',
  )
})

test('durations: leaves configured values and user strings alone', () => {
  const durations = rule('durations')
  for (const text of [
    'Exceeded timeout of 5000 ms for a test.',
    'Test timed out in 50ms.',
    'expected "5s" to be "6s"',
    'took 12 ms',
    'Time: soon, 5ms',
    '5 seconds and 2 items',
    'retry in (a few ms)',
  ]) {
    assert.equal(durations(text), text)
  }
})

test('placeholders: replaces uuids, hex addresses and /tmp paths', () => {
  const placeholders = rule('placeholders')
  assert.equal(placeholders('id 123e4567-e89b-12d3-a456-426614174000 done'), 'id <uuid> done')
  assert.equal(placeholders('at 0x7ffeeb3c4a10 and 0x1f'), 'at <addr> and 0x1f')
  assert.equal(placeholders('/tmp/abc123/x.ts:1:2'), '<tmp>/x.ts:1:2')
  assert.equal(placeholders('/private/tmp/jest_x/cache'), '<tmp>/cache')
  assert.equal(placeholders('/var/folders/ab/cd1234/T/run-9/out'), '<tmp>/out')
})

test('placeholders: /tmp needs a left boundary, so <root>/…/tmp/ is not a temp path', () => {
  const placeholders = rule('placeholders')
  assert.equal(placeholders('<root>/test/tmp/helper.ts'), '<root>/test/tmp/helper.ts')
  assert.equal(placeholders('/work/tmp/x'), '/work/tmp/x')
  assert.equal(placeholders('/foo/private/tmp/x'), '/foo/private/tmp/x')
  assert.equal(placeholders("open '/tmp/abc/x' (/tmp/def/y)"), "open '<tmp>/x' (<tmp>/y)")
})

test('stack: keeps the message and the first user frame', () => {
  const stack = rule('stack')
  const text = [
    'Error: boom',
    '    at helper (node_modules/lib/index.js:1:1)',
    '    at Object.<anonymous> (<root>/a.test.ts:9:26)',
    '    at Promise.then (<root>/b.test.ts:1:1)',
  ].join('\n')
  assert.equal(stack(text), 'Error: boom\nat <root>/a.test.ts:9:26')
  assert.equal(stack('no frames here'), 'no frames here')
})

test('stack: Object.<anonymous> with a file location is the user frame, not an internal one', () => {
  const error = normalizeError(
    'Error: x\n    at Object.<anonymous> (/work/fixture/a.test.ts:9:26)',
    ctx,
  )
  assert.equal(error.userFrame, '<root>/a.test.ts:9:26')
})

test('stack: a bare (<anonymous>) location is internal', () => {
  const error = normalizeError(
    [
      'Error: x',
      '    at new Promise (<anonymous>)',
      '    at Array.map (<anonymous>)',
      '    at run (/work/fixture/a.test.ts:3:4)',
    ].join('\n'),
    ctx,
  )
  assert.equal(error.userFrame, '<root>/a.test.ts:3:4')
})

test('stack: user text that starts with "at" is not a frame', () => {
  const error = normalizeError('Error: boom\n  at the end of the line', ctx)
  assert.equal(error.message, 'Error: boom\n  at the end of the line')
  assert.equal(error.userFrame, undefined)
  assert.equal(normalizeText('plain\n    at the end\n', ctx), 'plain\n    at the end\n')
})

test('stack: a line is a frame only as `at <fn> (<location>)` or `at <location>`', () => {
  const notFrames = [
    '    at foo bar baz',
    '    at fn (not a location)',
    '    at fn (/a.ts:1)',
    '    at /a.ts:x:y',
    '    at',
    '    at ',
  ]
  for (const line of notFrames) {
    const error = normalizeError(`Error: x\n${line}\n    at run (/work/fixture/a.test.ts:3:4)`, ctx)
    assert.equal(error.userFrame, '<root>/a.test.ts:3:4', line)
    assert.ok(error.message.includes(line.trim()) || line.trim() === 'at', line)
  }
  const frames = [
    '    at fn (/work/fixture/a.test.ts:3:4)',
    '    at /work/fixture/a.test.ts:3:4',
    '    at async /work/fixture/a.test.ts:3:4',
    '    at async Promise.all (index 0)',
    '    at Array.map (<anonymous>)',
    '    at fn (native)',
    '    at new Foo (/work/fixture/a.test.ts:3:4)',
    '    at C:\\work\\fixture\\a.test.ts:3:4',
  ]
  for (const line of frames) {
    assert.equal(normalizeError(`Error: x\n${line}`, ctx).message, 'Error: x', line)
  }
})

test('stack: only the trailing run of frame lines is the stack', () => {
  const raw = [
    'Error: expect(received).toBe(expected)',
    '',
    'Expected: "x"',
    'Received: "x',
    '  at fnA (/app/src/a.js:10:5)',
    'y"',
    '    at Object.toBe (/work/fixture/a.test.ts:7:23)',
    '    at Promise.then (/work/fixture/b.test.ts:1:1)',
    '',
  ].join('\n')
  const error = normalizeError(raw, ctx)
  assert.equal(error.userFrame, '<root>/a.test.ts:7:23')
  assert.equal(
    error.message,
    [
      'Error: expect(received).toBe(expected)',
      '',
      'Expected: "x"',
      'Received: "x',
      '  at fnA (/app/src/a.js:10:5)',
      'y"',
    ].join('\n'),
  )
  assert.equal(
    normalizeText(raw, ctx),
    `${error.message}\nat <root>/a.test.ts:7:23`,
    'the stack rule agrees with normalizeError',
  )
})

test('stack: a cause chain has a stack before each [cause]: line, and all of them are removed', () => {
  const raw = [
    'Error: thrown: Object {',
    '  "status": 404,',
    '}',
    '    at _getError (/repo/node_modules/jest-circus/build/x.js:1:1)',
    '    at Array.map (<anonymous>)',
    '',
    '[cause]: Error: thrown: Object {',
    '  "status": 404,',
    '}',
    '    at it (/work/fixture/a.test.ts:2:3)',
    '    at _dispatch (/repo/node_modules/jest-circus/build/x.js:2:2)',
  ].join('\n')
  const error = normalizeError(raw, ctx)
  assert.equal(error.userFrame, '<root>/a.test.ts:2:3')
  assert.equal(
    error.message,
    'Error: thrown: Object {\n  "status": 404,\n}\n\n[cause]: Error: thrown: Object {\n  "status": 404,\n}',
  )
  const caused = normalizeError(
    'Error: outer\n    at a (/work/fixture/a.test.ts:1:1)\nCaused by: Error: inner\n    at b (/work/fixture/b.test.ts:2:2)',
    ctx,
  )
  assert.equal(caused.message, 'Error: outer\nCaused by: Error: inner')
  assert.equal(caused.userFrame, '<root>/a.test.ts:1:1')
})

test('stack: frame-shaped lines with no real stack after them stay in the message', () => {
  const raw = 'Received: "x\n  at fnA (/app/src/a.js:10:5)\ny"'
  const error = normalizeError(raw, ctx)
  assert.equal(error.message, raw)
  assert.equal(error.userFrame, undefined)
})

test('stack: any <anonymous> location is internal, with or without a position', () => {
  const error = normalizeError(
    [
      'Error: x',
      '    at <anonymous>:1:1',
      '    at fn (<anonymous>:2:3)',
      '    at run (/work/fixture/a.test.ts:3:4)',
    ].join('\n'),
    ctx,
  )
  assert.equal(error.userFrame, '<root>/a.test.ts:3:4')
})

test('stack: an eval frame is the user frame of the file that called eval', () => {
  const evalFrame = '    at eval (eval at run (/work/fixture/a.test.ts:3:4), <anonymous>:1:1)'
  assert.equal(normalizeError(`Error: x\n${evalFrame}`, ctx).userFrame, '<root>/a.test.ts:3:4')
  const nested =
    '    at eval (eval at a (eval at b (/work/fixture/n.test.ts:5:6), <anonymous>:1:1), <anonymous>:2:2)'
  assert.equal(normalizeError(`Error: x\n${nested}`, ctx).userFrame, '<root>/n.test.ts:5:6')
  const lost = '    at eval (eval at <anonymous> (<anonymous>:1:1), <anonymous>:2:2)'
  assert.equal(
    normalizeError(`Error: x\n${lost}\n    at run (/work/fixture/b.test.ts:1:2)`, ctx).userFrame,
    '<root>/b.test.ts:1:2',
  )
})

test('stack: a file: URL with one slash is a rooted path, not a root-relative one', () => {
  const error = normalizeError(
    'Error: x\n    at strip (file:/work/fixture/a.test.ts:3:4)\n    at other (file:/Users/me/proj/jest-transform.ts:12:39)',
    ctx,
  )
  assert.equal(error.userFrame, '<root>/a.test.ts:3:4')
  const outside = normalizeError(
    'Error: x\n    at strip (file:/Users/me/proj/jest-transform.ts:12:39)',
    ctx,
  )
  assert.equal(outside.userFrame, '/Users/me/proj/jest-transform.ts:12:39')
})

test('the user frame keeps its path: only the path rules touch frames, not the message rules', () => {
  const frames = [
    ['/work/fixture/test/tmp/helper.test.ts:3:4', '<root>/test/tmp/helper.test.ts:3:4'],
    ['/work/fixture/10s.test.ts:3:4', '<root>/10s.test.ts:3:4'],
    ['/work/fixture/0xdeadbeef01/a.test.ts:1:1', '<root>/0xdeadbeef01/a.test.ts:1:1'],
    [
      '/work/fixture/123e4567-e89b-12d3-a456-426614174000/a.ts:1:1',
      '<root>/123e4567-e89b-12d3-a456-426614174000/a.ts:1:1',
    ],
    ['/work/fixture/(12 ms)/a.ts:1:1', '<root>/(12 ms)/a.ts:1:1'],
  ] as const
  for (const [location, expected] of frames) {
    const error = normalizeError(`Error: x\n    at run (${location})`, ctx)
    assert.equal(error.userFrame, expected, location)
    assert.equal(
      normalizeText(`Error: x\n    at run (${location})`, ctx),
      `Error: x\nat ${expected}`,
    )
  }
})

test('the message rules still apply to the message', () => {
  const raw = [
    'Error: 0x7ffeeb3c4a10 failed (12 ms) in /tmp/abc123/x',
    '',
    '  > 4 | x()',
    '      | ^',
    '',
    '    at run (/work/fixture/a.test.ts:4:1)',
  ].join('\n')
  const fired = new Set<string>()
  const error = normalizeError(raw, ctx, undefined, fired)
  assert.equal(error.message, 'Error: <addr> failed (<dur>) in <tmp>/x')
  assert.deepEqual([...fired].sort(), ['code-frames', 'durations', 'placeholders', 'root', 'stack'])
})

test('normalizeText runs every rule and reports the ones that changed the text', () => {
  const fired = new Set<string>()
  const out = normalizeText('\u001b[1mfailed\u001b[22m (12 ms)', ctx, fired)
  assert.equal(out, 'failed (<dur>)')
  assert.deepEqual([...fired].sort(), ['ansi', 'durations'])
  const quiet = new Set<string>()
  assert.equal(normalizeText('nothing to do', ctx, quiet), 'nothing to do')
  assert.equal(quiet.size, 0)
})

test('normalizeError splits a Jest failure into message, matcher and user frame', () => {
  const raw = [
    'Error: expect(received).toBe(expected) // Object.is equality',
    '',
    'Expected: 4',
    'Received: 3',
    '    at Object.toBe (/work/fixture/a.test.ts:7:23)',
    '    at Promise.finally.completed (/repo/node_modules/.pnpm/jest-circus@30/node_modules/jest-circus/build/jestAdapterInit.js:1834:28)',
    '    at new Promise (<anonymous>)',
  ].join('\n')
  const fired = new Set<string>()
  const error = normalizeError(raw, ctx, 'toBe', fired)
  assert.deepEqual(error, {
    name: 'Error',
    message:
      'Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 4\nReceived: 3',
    matcher: 'toBe',
    userFrame: '<root>/a.test.ts:7:23',
    raw,
  })
  assert.deepEqual([...fired].sort(), ['root', 'stack'])
})

test('normalizeError reads a Vitest failure whose frames are file:// URLs', () => {
  const raw = [
    'AssertionError: expected 3 to be 4 // Object.is equality',
    '    at /work/fixture/a.test.ts:7:23',
    '    at file:///repo/node_modules/.pnpm/vitest@5/node_modules/vitest/dist/chunks/run.js:1632:35',
  ].join('\n')
  const error = normalizeError(raw, ctx)
  assert.equal(error.name, 'AssertionError')
  assert.equal(error.message, 'AssertionError: expected 3 to be 4 // Object.is equality')
  assert.equal(error.userFrame, '<root>/a.test.ts:7:23')
  assert.equal('matcher' in error, false)
})

test('normalizeError skips node:internal, node: and vitest/dist frames', () => {
  const error = normalizeError(
    [
      'Error: x',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
      '    at readFileSync (node:fs:441:20)',
      '    at file:///repo/vitest/dist/run.js:1:1',
      '    at /work/fixture/b.test.ts:2:3',
    ].join('\n'),
    ctx,
  )
  assert.equal(error.userFrame, '<root>/b.test.ts:2:3')
})

test('normalizeError makes a root-relative frame (Jest file-level messages) <root>-relative', () => {
  const error = normalizeError(
    '  ● suite\n\n    boom\n\n      at Object.toBe (a.test.ts:7:23)\n',
    ctx,
  )
  assert.equal(error.userFrame, '<root>/a.test.ts:7:23')
  assert.equal(error.message, '● suite\n\n    boom')
})

test('normalizeError has no frame and no name for a thrown string', () => {
  const error = normalizeError('thrown: "a string"', ctx)
  assert.deepEqual(error, { message: 'thrown: "a string"', raw: 'thrown: "a string"' })
})

test('normalizeError strips colour, code frames and durations from the message', () => {
  const raw = [
    '\u001b[31mTypeError: x is not a function\u001b[39m (3 ms)',
    '',
    '  > 4 | x()',
    '      | ^',
    '    at run (/work/fixture/a.test.ts:4:1)',
  ].join('\n')
  const error = normalizeError(raw, ctx)
  assert.equal(error.name, 'TypeError')
  assert.equal(error.message, 'TypeError: x is not a function (<dur>)')
  assert.equal(error.raw, raw)
})

test('testKey joins the path with › and appends the duplicate index', () => {
  assert.equal(testKey({ file: 'a.test.ts', path: ['a', 'b'], dupIndex: 0 }), 'a.test.ts::a › b#0')
  assert.equal(testKey({ file: 'x/y.test.ts', path: ['only'], dupIndex: 2 }), 'x/y.test.ts::only#2')
})

test('testKey escapes the separator and the escape character inside a title', () => {
  const key = (path: readonly string[]) => testKey({ file: 'a.test.ts', path, dupIndex: 0 })
  assert.equal(key(['a', 'b']), 'a.test.ts::a › b#0')
  assert.equal(key(['a › b']), 'a.test.ts::a \\› b#0')
  assert.equal(key(['a\\', 'b']), 'a.test.ts::a\\\\ › b#0')
  assert.equal(key(['a\\› b']), 'a.test.ts::a\\\\\\› b#0')
  // Titles without either character are printed as they are, whatever else they hold.
  assert.equal(key(['a - b', 'c: d (1)', '日本語 #2']), 'a.test.ts::a - b › c: d (1) › 日本語 #2#0')
})

test('testKey gives different title paths different keys', () => {
  const pieces = ['a', 'b', ' ', '›', '\\', '\\›', ' › ', '›b', 'a›', '']
  const paths: string[][] = []
  const grow = (path: string[], depth: number): void => {
    if (path.length > 0) paths.push(path)
    if (depth === 0) return
    for (const piece of pieces) grow([...path, piece], depth - 1)
  }
  grow([], 3)
  const keys = new Map<string, string>()
  for (const path of paths) {
    const key = testKey({ file: 'a.test.ts', path, dupIndex: 0 })
    const other = keys.get(key)
    assert.equal(other, undefined, `${JSON.stringify(path)} and ${other} share ${key}`)
    keys.set(key, JSON.stringify(path))
  }
  assert.equal(keys.size, paths.length)
})

test('every rule has a scope, and the path rules are the ones that touch frames', () => {
  assert.deepEqual(
    rules.map((r) => [r.id, r.scope]),
    [
      ['ansi', 'path'],
      ['crlf', 'path'],
      ['file-url', 'path'],
      ['root', 'path'],
      ['windows-separators', 'path'],
      ['code-frames', 'message'],
      ['durations', 'message'],
      ['placeholders', 'message'],
      ['stack', 'stack'],
    ],
  )
})

test('a very long line with no closing parenthesis is read in linear time', {
  timeout: 1_000,
}, () => {
  const line = `    at ${'a (b '.repeat(18_000)}`
  const error = normalizeError(`Error: x\n${line}`, ctx)
  assert.equal(error.message, `Error: x\n${line}`.trim())
  assert.equal(error.userFrame, undefined)
})

test('a context is compiled once and can normalize many failures', () => {
  const normalizer = createNormalizer({ rootDir: '/work/fixture' })
  const fired = new Set<string>()
  for (const file of ['a', 'b', 'c']) {
    const raw = `Error: x\n    at run (/work/fixture/${file}.test.ts:1:2)`
    assert.deepEqual(normalizer.error(raw, 'toBe', fired), normalizeError(raw, ctx, 'toBe'))
    assert.equal(normalizer.text(raw), normalizeText(raw, ctx))
  }
  assert.deepEqual([...fired].sort(), ['root', 'stack'])
})
