// `collectOpenHandles` (T9.10) on real resources made by real modules, and `codeFrame` against the
// text babel's code frame gives with colour off (what Jest prints).
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import { codeFrame, collectOpenHandles } from './open-handles.ts'

describe('codeFrame', () => {
  const source = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].join('\n')

  it('marks the line with > and a caret under the column, two lines above and three below', () => {
    assert.equal(
      codeFrame(source, 4, 2),
      [
        '  2 | two',
        '  3 | three',
        '> 4 | four',
        '    |  ^',
        '  5 | five',
        '  6 | six',
        '  7 | seven',
      ].join('\n'),
    )
  })

  it('starts at the first line and ends at the last', () => {
    assert.equal(
      codeFrame(source, 1, 1),
      ['> 1 | one', '    | ^', '  2 | two', '  3 | three', '  4 | four'].join('\n'),
    )
    assert.equal(
      codeFrame(source, 7, 3),
      ['  5 | five', '  6 | six', '> 7 | seven', '    |   ^'].join('\n'),
    )
  })

  it('pads the numbers to the width of the last one, and keeps a tab where the caret is placed', () => {
    const long = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`)
    long[9] = '\tindented'
    assert.equal(
      codeFrame(long.join('\n'), 10, 2),
      [
        '   8 | line 8',
        '   9 | line 9',
        '> 10 | \tindented',
        '     | \t^',
        '  11 | line 11',
        '  12 | line 12',
      ].join('\n'),
    )
  })

  it('leaves an empty line with no trailing space, and reads CRLF', () => {
    assert.equal(
      codeFrame('a\r\n\r\nb', 1, 1),
      ['> 1 | a', '    | ^', '  2 |', '  3 | b'].join('\n'),
    )
  })
})

describe('collectOpenHandles', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'provino-handles-')))
  after(() => rmSync(dir, { recursive: true, force: true }))

  /** A module of the "project": its functions make resources, and return them to be cleaned up. */
  async function project(name: string, text: string): Promise<Record<string, () => unknown>> {
    const file = join(dir, name)
    writeFileSync(file, text)
    return (await import(pathToFileURL(file).href)) as Record<string, () => unknown>
  }

  it('reports an interval a project file made, with the kind, the frame and a code frame', async () => {
    const mod = await project(
      'leaks.mjs',
      ['export function leak() {', '  return setInterval(() => {}, 1000)', '}', ''].join('\n'),
    )
    const collect = collectOpenHandles({ roots: [dir] })
    const timer = mod.leak() as NodeJS.Timeout
    try {
      const handles = await collect()
      assert.equal(handles.length, 1)
      const [handle] = handles
      assert.equal(handle?.type, 'Timeout')
      assert.match(handle?.frames[0] ?? '', /\(leaks\.mjs:2:10\)$/)
      assert.equal(
        handle?.codeFrame,
        [
          '  1 | export function leak() {',
          '> 2 |   return setInterval(() => {}, 1000)',
          '    |          ^',
          '  3 | }',
          '  4 |',
        ].join('\n'),
      )
    } finally {
      clearInterval(timer)
    }
  })

  it('does not report a timer that was cleared, one that is unref’d, or one made outside the roots', async () => {
    const mod = await project(
      'quiet.mjs',
      [
        'export function cleared() {',
        '  clearInterval(setInterval(() => {}, 1000))',
        '}',
        'export function unrefd() {',
        '  return setInterval(() => {}, 1000).unref()',
        '}',
        '',
      ].join('\n'),
    )
    const collect = collectOpenHandles({ roots: [dir] })
    mod.cleared?.()
    const unrefd = mod.unrefd?.() as NodeJS.Timeout
    // Made by this file, which is Provino's own: not the project's.
    const outside = setInterval(() => {}, 1000)
    try {
      assert.deepEqual(await collect(), [])
    } finally {
      clearInterval(outside)
      clearInterval(unrefd)
    }
  })

  it('makes one entry of handles with the same stack, and one each for different lines', async () => {
    const mod = await project(
      'many.mjs',
      [
        'export function same() {',
        '  const made = []',
        '  for (let i = 0; i < 3; i++) made.push(setInterval(() => {}, 1000))',
        '  return made',
        '}',
        'export function other() {',
        '  return setInterval(() => {}, 1000)',
        '}',
        '',
      ].join('\n'),
    )
    const collect = collectOpenHandles({ roots: [dir] })
    const made = mod.same?.() as NodeJS.Timeout[]
    const one = mod.other?.() as NodeJS.Timeout
    try {
      const handles = await collect()
      assert.equal(handles.length, 2)
      assert.deepEqual(
        handles.map((handle) => /many\.mjs:(\d+):/.exec(handle.frames[0] ?? '')?.[1]).sort(),
        ['3', '7'],
      )
    } finally {
      for (const timer of [...made, one]) clearInterval(timer)
    }
  })

  it('stops tracking when it is asked for the result', async () => {
    const mod = await project(
      'after.mjs',
      ['export function leak() {', '  return setInterval(() => {}, 1000)', '}', ''].join('\n'),
    )
    const collect = collectOpenHandles({ roots: [dir] })
    assert.deepEqual(await collect(), [])
    const late = mod.leak?.() as NodeJS.Timeout
    try {
      // A second collector, started now, sees the timer only if the first one's hook is gone and
      // this one's is on: it knows nothing of what came before it.
      const again = collectOpenHandles({ roots: [dir] })
      assert.deepEqual(await again(), [], 'a timer made before it started is not its to report')
    } finally {
      clearInterval(late)
    }
  })
})
