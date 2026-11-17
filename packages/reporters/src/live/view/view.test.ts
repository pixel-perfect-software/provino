import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStyle } from '../../style.ts'
import { GLYPHS } from '../terminal/glyphs.ts'
import { displayWidth } from '../terminal/width.ts'
import { clock, groupDigits, roughDuration } from './format.ts'
import { type StatusInput, statusLine } from './status-line.ts'
import { moreWorkersLine, SLOW_FILE_MS, workerLine } from './worker-line.ts'

const plain = createStyle(false)
const input: StatusInput = {
  passed: 1204,
  failed: 3,
  skipped: 12,
  todo: 0,
  filesDone: 1204,
  filesTotal: 1980,
  elapsedMs: 12_400,
  leftMs: 8000,
}

test('numbers and clocks', () => {
  assert.equal(groupDigits(0), '0')
  assert.equal(groupDigits(999), '999')
  assert.equal(groupDigits(1204), '1,204')
  assert.equal(groupDigits(1234567), '1,234,567')
  assert.equal(clock(800), '0.8s')
  assert.equal(clock(12_450), '12.4s')
  assert.equal(clock(65_000), '1m 05s')
  assert.equal(clock(3_720_000), '1h 02m')
  assert.equal(roughDuration(8000), '8s')
  assert.equal(roughDuration(90_000), '2m')
})

test('the status line at 120 columns has counts, bar, percent, files and time', () => {
  const text = statusLine(input, 120, GLYPHS.emoji, plain)
  assert.match(
    text,
    /^✅ 1,204 {2}❌ 3 {2}⏩ 12 {3}█+░+ {2} 60% {2}1,204 of 1,980 files {3}12\.4s · ~8s left$/,
  )
  assert.ok(displayWidth(text) <= 119)
})

test('zero counts other than passed are left out', () => {
  const text = statusLine({ ...input, failed: 0, skipped: 0 }, 120, GLYPHS.emoji, plain)
  assert.ok(text.startsWith('✅ 1,204   '))
  assert.ok(!text.includes('❌') && !text.includes('⏩'))
})

test('at a narrow width the bar goes first, then the file count, then the time left', () => {
  const widths = [120, 70, 60, 50, 40, 30]
  const lines = widths.map((columns) => statusLine(input, columns, GLYPHS.emoji, plain))
  for (const [i, text] of lines.entries()) {
    assert.ok(displayWidth(text) <= (widths[i] as number) - 1, `${widths[i]}: ${text}`)
  }
  assert.ok(/[█░]/.test(lines[0] as string))
  assert.ok(!/[█░]/.test(lines[2] as string))
  assert.ok((lines[2] as string).includes('files'))
  assert.ok(!(lines[4] as string).includes('files'))
  assert.ok(!(lines[4] as string).includes('left'))
  assert.ok((lines[4] as string).includes('60%'))
})

test('the ascii set uses # and . for the bar', () => {
  const text = statusLine(input, 120, GLYPHS.ascii, plain)
  assert.match(text, /^ok 1,204 {2}x 3 {2}- 12 {3}#+\.+ /)
})

test('colour changes no width', () => {
  const coloured = statusLine(input, 100, GLYPHS.emoji, createStyle(true))
  assert.equal(displayWidth(coloured), displayWidth(statusLine(input, 100, GLYPHS.emoji, plain)))
})

test('with no files the percent is 0 and nothing divides by zero', () => {
  const text = statusLine(
    { ...input, filesDone: 0, filesTotal: 0, passed: 0, failed: 0, skipped: 0 },
    100,
    GLYPHS.emoji,
    plain,
  )
  assert.ok(text.includes('0%'))
})

test('a shard is named after the files', () => {
  const text = statusLine({ ...input, shard: 'shard 2/3' }, 120, GLYPHS.emoji, plain)
  assert.ok(text.includes('1,980 files · shard 2/3'), text)
})

test('a worker line: spinner, number, path, time; the path is cut from the left', () => {
  const line = workerLine(2, 'src/hooks/use-cart.test.tsx', 2100, 1, 60, GLYPHS.emoji)
  assert.ok(line.startsWith(' ⠙ 2  '))
  assert.ok(line.endsWith(`2.1s ${GLYPHS.emoji.slow}`))
  assert.equal(displayWidth(line), 59)
  const narrow = workerLine(2, 'src/hooks/use-cart.test.tsx', 800, 0, 30, GLYPHS.emoji)
  assert.ok(narrow.includes('…'))
  assert.ok(narrow.includes('cart.test.tsx'))
  assert.ok(narrow.endsWith('0.8s'))
  assert.ok(displayWidth(narrow) <= 29)
})

test('a file is marked slow from the threshold on', () => {
  assert.ok(!workerLine(1, 'a.ts', SLOW_FILE_MS - 100, 0, 80, GLYPHS.emoji).includes('🐢'))
  assert.ok(workerLine(1, 'a.ts', SLOW_FILE_MS, 0, 80, GLYPHS.emoji).includes('🐢'))
  assert.ok(workerLine(1, 'a.ts', SLOW_FILE_MS, 0, 80, GLYPHS.ascii).endsWith('2.0s slow'))
})

test('the spinner phase wraps', () => {
  assert.equal(workerLine(1, 'a.ts', 0, 0, 40, GLYPHS.ascii)[1], '-')
  assert.equal(workerLine(1, 'a.ts', 0, 5, 40, GLYPHS.ascii)[1], '\\')
  assert.equal(moreWorkersLine(1), ' + 1 more worker')
  assert.equal(moreWorkersLine(8), ' + 8 more workers')
})
