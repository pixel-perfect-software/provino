import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { type FileKind, type FolderFile, groupByFolder } from '../../internal/views/folders.ts'
import { createStyle } from '../../style.ts'
import { GLYPHS } from '../terminal/glyphs.ts'
import { displayWidth } from '../terminal/width.ts'
import { mapLegend, mapLines } from './map.ts'

const plain = createStyle(false)
const colour = createStyle(true)

function file(path: string, kind: FileKind = 'pass', project = ''): FolderFile {
  return { path, project, kind, tests: 1, failed: 0, skipped: 0, durationMs: 1 }
}

function lines(
  files: readonly FolderFile[],
  columns = 80,
  set: 'emoji' | 'ascii' | 'unicode' = 'emoji',
  style = plain,
) {
  return mapLines(groupByFolder(files), columns, GLYPHS[set], style)
}

describe('the status map', () => {
  test('a legend, then a row per folder: one cell per file in path order', () => {
    const out = lines([
      file('src/b/y.test.ts', 'fail'),
      file('src/b/x.test.ts'),
      file('src/a/z.test.ts', 'skip'),
      file('top.test.ts', 'todo'),
    ])
    assert.deepEqual(out, [
      '🟩 pass  🟥 fail  🟨 skip  ⬜ todo',
      './      ⬜',
      'src/a/  🟨',
      'src/b/  🟩🟥',
    ])
  })

  test('the other sets draw a letter for each outcome, so it reads without colour', () => {
    for (const set of ['ascii', 'unicode'] as const) {
      const out = lines(
        [file('a/1.ts'), file('a/2.ts', 'fail'), file('a/3.ts', 'skip'), file('a/4.ts', 'todo')],
        80,
        set,
      )
      assert.equal(out[0], '. pass  X fail  s skip  t todo')
      assert.equal(out[1], 'a/  .Xst')
    }
  })

  test('a letter cell is coloured by outcome; an emoji square is left as it is', () => {
    const files = [
      file('a/1.ts'),
      file('a/2.ts', 'fail'),
      file('a/3.ts', 'skip'),
      file('a/4.ts', 'todo'),
    ]
    const row = lines(files, 80, 'ascii', colour)[1] as string
    assert.ok(row.includes('\u001b[32m.\u001b[39m'))
    assert.ok(row.includes('\u001b[31mX\u001b[39m'))
    assert.ok(row.includes('\u001b[33ms\u001b[39m'))
    assert.ok(row.includes('\u001b[2mt\u001b[22m'))
    const emoji = lines(files, 80, 'emoji', colour)[1] as string
    assert.ok(!emoji.includes('\u001b[32m'))
    assert.ok(!lines(files, 80, 'ascii').join('\n').includes('\u001b'))
  })

  test('a row wraps at the width, the next rows under the cells; no line is wider than the terminal less one', () => {
    const files = Array.from({ length: 30 }, (_, index) =>
      file(`src/components/c${String(index).padStart(2, '0')}.test.ts`),
    )
    for (const set of ['emoji', 'ascii'] as const) {
      for (const columns of [20, 40, 80, 120]) {
        const out = lines(files, columns, set)
        for (const line of out)
          assert.ok(displayWidth(line) <= columns - 1, `${set} ${columns}: ${line}`)
        const cell = set === 'emoji' ? '🟩' : '.'
        const cells = out.slice(1).join('').split(cell).length - 1
        assert.equal(cells, 30, `${set} ${columns}: every file has its cell`)
      }
    }
    const narrow = lines(files, 40)
    assert.equal(narrow.length, 1 + 3)
    assert.ok((narrow[2] as string).startsWith(' '.repeat('src/components/'.length + 2)))
  })

  test('a long folder name is cut from the left, to a share of the width', () => {
    const out = lines([file(`${'deep/'.repeat(20)}x.test.ts`), file('a/b.test.ts')], 40)
    const [, short, long] = out as [string, string, string]
    assert.ok(long.startsWith('…'))
    // The label gets 40% of the 39 usable columns, then the gap.
    const column = (line: string): number => displayWidth(line.slice(0, line.indexOf('🟩')))
    assert.equal(column(long), 15 + 2)
    // Both rows start their cells in the same column.
    assert.equal(column(short), column(long))
  })

  test('two projects with a folder of the same name are two rows, the project first', () => {
    const out = lines([file('src/a.ts', 'pass', 'web'), file('src/a.ts', 'fail', 'api')])
    assert.match(out[1] as string, /^api src\/ +🟥$/)
    assert.match(out[2] as string, /^web src\/ +🟩$/)
  })

  test('the legend names each cell; no files, only the legend', () => {
    assert.equal(mapLegend(GLYPHS.emoji, plain), '🟩 pass  🟥 fail  🟨 skip  ⬜ todo')
    assert.deepEqual(lines([]), ['🟩 pass  🟥 fail  🟨 skip  ⬜ todo'])
  })

  test('cells of different widths: rows are cut by the widest cell, so none can wrap', () => {
    // A hand-made set whose fail cell is wider than the rest (the built-in sets keep them equal).
    const mixed = { ...GLYPHS.ascii, cell: { pass: '.', fail: '🟥', skipped: 's', todo: 't' } }
    const kinds: FileKind[] = ['pass', 'fail', 'skip', 'todo', 'fail']
    const files = Array.from({ length: 53 }, (_, index) =>
      file(`q/f${String(index).padStart(2, '0')}.ts`, kinds[index % kinds.length]),
    )
    const wide = files.filter((each) => each.kind === 'fail').length
    for (const columns of [12, 20, 40, 80]) {
      const out = mapLines(groupByFolder(files), columns, mixed, plain)
      for (const line of out) assert.ok(displayWidth(line) <= columns - 1, `${columns}: ${line}`)
      // Every file has its cell: the rows less their label, and the legend's.
      const prefix = 'q/'.length + 2
      const cells = out.slice(1).reduce((sum, row) => sum + displayWidth(row) - prefix, 0)
      assert.equal(cells, files.length - wide + wide * 2, `${columns}: ${out.join('|')}`)
    }
  })

  test('an emoji cell is two columns wide: the sets’ cells all agree within a set', () => {
    for (const set of ['emoji', 'unicode', 'ascii'] as const) {
      const widths = new Set(Object.values(GLYPHS[set].cell).map((cell) => displayWidth(cell)))
      assert.equal(widths.size, 1, set)
    }
    assert.equal(displayWidth(GLYPHS.emoji.cell.pass), 2)
  })
})
