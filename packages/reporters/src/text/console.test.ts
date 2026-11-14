// The fallback layout of a console entry's `at` line (used where a dialect gives no trace of its
// own): Jest's `formatStackTrace` puts frames at 6 spaces whatever the title's indent, keeps the
// first frame under `--noStackTrace`, and makes a path relative to the root only where it starts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStyle } from '../style.ts'
import { type ConsoleEntry, consoleEntries } from './console.ts'

const style = createStyle(false)

function entry(origin: string, level = 'log'): ConsoleEntry {
  return { stream: 'stdout', level, text: 'hi\n', origin }
}

test('the at line is at 6 spaces under --verbose, where the title is at 2', () => {
  const text = consoleEntries(
    [entry('at Object.log (/p/a.test.ts:2:11)')],
    { titleIndent: 2, stackTrace: true, root: '/p' },
    style,
  )
  assert.equal(text, '  console.log\n    hi\n\n      at Object.log (a.test.ts:2:11)\n')
})

test('a warn keeps its first frame under --noStackTrace', () => {
  const text = consoleEntries(
    [entry('at Object.warn (/p/a.test.ts:3:11)', 'warn')],
    { titleIndent: 4, stackTrace: false, root: '/p' },
    style,
  )
  assert.match(text, /\n {6}at Object\.warn \(a\.test\.ts:3:11\)\n$/)
})

test('the root is stripped where the path starts, and nowhere else', () => {
  const format = { titleIndent: 4, stackTrace: true, root: '/app' } as const
  const frame = (origin: string): string =>
    consoleEntries([entry(origin)], format, style)
      .split('\n')
      .at(-2) ?? ''
  assert.equal(frame('at f (/app/src/a.ts:1:1)'), '      at f (src/a.ts:1:1)')
  assert.equal(frame('at /app/src/a.ts:1:1'), '      at src/a.ts:1:1')
  // Not under the root: /app is only part of another path.
  assert.equal(frame('at f (/home/u/app/src/a.ts:1:1)'), '      at f (/home/u/app/src/a.ts:1:1)')
  assert.equal(
    frame('at f (file:///work/app/src/a.ts:1:1)'),
    '      at f (file:///work/app/src/a.ts:1:1)',
  )
})
