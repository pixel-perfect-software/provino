import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
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

test('root: a nested extra root wins over its parent', () => {
  const root = rule('root')
  assert.equal(
    root('/work/fixture/pkg/a.ts', { rootDir: '/work/fixture', extraRoots: ['/work/fixture/pkg'] }),
    '<root>/a.ts',
  )
})

test('windows-separators: converts paths after <root> or a drive letter', () => {
  const windows = rule('windows-separators')
  assert.equal(windows('<root>\\src\\a.test.ts:9:26'), '<root>/src/a.test.ts:9:26')
  assert.equal(windows('at C:\\Users\\me\\a.ts:1:2'), 'at C:/Users/me/a.ts:1:2')
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

test('durations: replaces times with <dur>', () => {
  const durations = rule('durations')
  assert.equal(durations('took 12 ms'), 'took <dur>')
  assert.equal(durations('Time: 1.234 s, 5ms, 3µs'), 'Time: <dur>, <dur>, <dur>')
  assert.equal(durations('5 seconds and 2 items'), '5 seconds and 2 items')
})

test('placeholders: replaces uuids, hex addresses and /tmp paths', () => {
  const placeholders = rule('placeholders')
  assert.equal(placeholders('id 123e4567-e89b-12d3-a456-426614174000 done'), 'id <uuid> done')
  assert.equal(placeholders('at 0x7ffeeb3c4a10 and 0x1f'), 'at <addr> and 0x1f')
  assert.equal(placeholders('/tmp/abc123/x.ts:1:2'), '<tmp>/x.ts:1:2')
  assert.equal(placeholders('/private/tmp/jest_x/cache'), '<tmp>/cache')
  assert.equal(placeholders('/var/folders/ab/cd1234/T/run-9/out'), '<tmp>/out')
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

test('normalizeText runs every rule and reports the ones that changed the text', () => {
  const fired = new Set<string>()
  const out = normalizeText('\u001b[1mfailed\u001b[22m in 12 ms', ctx, fired)
  assert.equal(out, 'failed in <dur>')
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
    '\u001b[31mTypeError: x is not a function\u001b[39m in 3 ms',
    '',
    '  > 4 | x()',
    '      | ^',
    '    at run (/work/fixture/a.test.ts:4:1)',
  ].join('\n')
  const error = normalizeError(raw, ctx)
  assert.equal(error.name, 'TypeError')
  assert.equal(error.message, 'TypeError: x is not a function in <dur>')
  assert.equal(error.raw, raw)
})

test('testKey joins the path with › and appends the duplicate index', () => {
  assert.equal(testKey({ file: 'a.test.ts', path: ['a', 'b'], dupIndex: 0 }), 'a.test.ts::a › b#0')
  assert.equal(testKey({ file: 'x/y.test.ts', path: ['only'], dupIndex: 2 }), 'x/y.test.ts::only#2')
})
