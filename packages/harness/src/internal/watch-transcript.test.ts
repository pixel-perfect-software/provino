import assert from 'node:assert/strict'
import { test } from 'provino'
import { CLEAR_ROW, maskTimes, renderTranscript } from './watch-transcript.ts'

const ESC = '\u001b'
/** jest-util's `CLEAR` on macOS and Linux. */
const CLEAR = `${ESC}[2J${ESC}[3J${ESC}[H`

/** What Jest's `Status.get()` returns for content with `height` newlines (`Status.ts` L192-200). */
function statusClear(height: number): string {
  return `\r${ESC}[K\r${ESC}[1A`.repeat(height)
}

test('plain text and a terminal newline become rows, without trailing spaces or blank rows', () => {
  assert.equal(
    renderTranscript('PASS a.test.ts  \r\nTests: 1 passed\r\n\r\n'),
    'PASS a.test.ts\nTests: 1 passed',
  )
  assert.equal(renderTranscript('one\ntwo'), 'one\ntwo')
})

test('a live status block that Jest erases leaves no rows, however often it was drawn', () => {
  const status = (runs: string): string =>
    `\n RUNS  ${runs}\n\nTest Suites: 0 of 1 total\nTime: 1 s`
  const height = (text: string): number => [...text].filter((char) => char === '\n').length
  const once = status('a.test.ts')
  // The status is drawn, cleared and drawn again by the reporter's timer, then cleared for the
  // result: a run that redrew it three times leaves what a run that drew it once leaves.
  let redrawn = `${CLEAR}Determining test suites to run...${ESC}[999D${ESC}[K`
  for (let index = 0; index < 3; index += 1) redrawn += `${once}${statusClear(height(once))}`
  redrawn += 'PASS a.test.ts\nTests: 1 passed'
  const drawnOnce = `${CLEAR}Determining test suites to run...${ESC}[999D${ESC}[K${once}${statusClear(height(once))}PASS a.test.ts\nTests: 1 passed`
  assert.equal(renderTranscript(redrawn), renderTranscript(drawnOnce))
  assert.equal(renderTranscript(redrawn), `${CLEAR_ROW}\nPASS a.test.ts\nTests: 1 passed`)
})

test('each screen clear is a <CLEAR> row, and the cursor moves from the new screen top', () => {
  const out = renderTranscript(`first run\n${CLEAR}second${ESC}[1;3HX`)
  assert.equal(out, `first run\n${CLEAR_ROW}\nseXond`)
  assert.equal(renderTranscript(`${CLEAR}a`), `${CLEAR_ROW}\na`)
})

test('the pattern prompt keeps only what its line last showed', () => {
  // `PatternPrompt._onChange` then `printPatternCaret` and `printRestoredPatternCaret` per key.
  const usage = `${CLEAR}\nPattern Mode Usage\n › Press Esc to exit pattern mode.\n\n`
  const draw = (value: string): string =>
    `${ESC}[2K${ESC}[G${ESC}[J pattern › ${value}${ESC}7${ESC}[5;${12 + value.length}H${ESC}8`
  const out = renderTranscript(usage + draw('') + draw('f') + draw('fo') + draw('foo'))
  assert.equal(
    out,
    `${CLEAR_ROW}\n\nPattern Mode Usage\n › Press Esc to exit pattern mode.\n\n pattern › foo`,
  )
  // A backspace redraw is shorter: what the erase removed is gone.
  assert.match(renderTranscript(usage + draw('foo') + draw('fo')), / pattern › fo$/)
})

test('erase to the end of the line, from its start, the whole line, and down', () => {
  assert.equal(renderTranscript(`abcdef${ESC}[3D${ESC}[K`), 'abc')
  assert.equal(renderTranscript(`abcdef${ESC}[3D${ESC}[1K`), '    ef')
  assert.equal(renderTranscript(`abc${ESC}[2Kx`), '   x')
  assert.equal(renderTranscript(`one\ntwo\nthree${ESC}[2A${ESC}[J`), 'one')
  assert.equal(renderTranscript(`ab\rX`), 'Xb')
})

test('colours, private modes, hyperlinks and other control characters show nothing', () => {
  assert.equal(
    renderTranscript(
      `${ESC}[?25l${ESC}[1m${ESC}[31mFAIL${ESC}[39m${ESC}[22m${ESC}[?25h${ESC}[?2026h x${ESC}[?2026l\u0007${ESC}]8;;http://x\u0007link${ESC}]8;;\u0007`,
    ),
    'FAIL xlink',
  )
})

test('a row wraps at the terminal width, and code points take one column each', () => {
  assert.equal(renderTranscript('abcdef', { rows: 40, columns: 4 }), 'abcd\nef')
  assert.equal(renderTranscript(`✓ a✕${ESC}[2D○`), '✓ ○✕')
  assert.equal(renderTranscript('😀x'), '😀x')
})

test('cursor up never leaves the screen that the last clear began', () => {
  assert.equal(renderTranscript(`before\n${CLEAR}a${ESC}[5Ab`), `before\n${CLEAR_ROW}\nab`)
})

test('times are masked, and words after a number are not', () => {
  assert.equal(
    maskTimes('Time:        0.512 s, estimated 2 s\n  ✓ works (5 ms)\nSnapshots:   2 snapshots'),
    'Time:        <time>, estimated <time>\n  ✓ works (<time>)\nSnapshots:   2 snapshots',
  )
})
