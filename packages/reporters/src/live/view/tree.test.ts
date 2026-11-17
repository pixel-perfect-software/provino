import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { groupByFolder } from '../../internal/views/folders.ts'
import { createStyle } from '../../style.ts'
import type { OpenFile, TreeFile, TreeNode } from '../model/tree-store.ts'
import { GLYPHS } from '../terminal/glyphs.ts'
import { displayWidth } from '../terminal/width.ts'
import { folderLabel, treeLines } from './tree.ts'

const plain = createStyle(false)
const colour = createStyle(true)

function passing(path: string, extra: Partial<TreeFile> = {}): TreeFile {
  return {
    path,
    project: '',
    kind: 'pass',
    tests: 4,
    failed: 0,
    skipped: 0,
    durationMs: 12,
    open: undefined,
    ...extra,
  }
}

function test_(name: string, message?: string, durationMs = 5): TreeNode {
  return {
    kind: 'test',
    name,
    state: 'fail',
    tests: 1,
    failed: 1,
    skipped: 0,
    durationMs,
    message,
    children: [],
    rest: undefined,
  }
}

function suite(name: string, extra: Partial<TreeNode> = {}): TreeNode {
  return {
    kind: 'suite',
    name,
    state: 'pass',
    tests: 2,
    failed: 0,
    skipped: 0,
    durationMs: 3,
    message: undefined,
    children: [],
    rest: undefined,
    ...extra,
  }
}

function failing(path: string, open: Partial<OpenFile> = {}): TreeFile {
  return {
    path,
    project: '',
    kind: 'fail',
    tests: 9,
    failed: 1,
    skipped: 0,
    durationMs: 120,
    open: { children: [], rest: undefined, messages: [], moreFailed: 0, ...open },
  }
}

const SAMPLE: readonly TreeFile[] = [
  passing('src/a/ok.test.ts'),
  failing('src/a/bad.test.ts', {
    children: [
      suite('cart', {
        state: 'fail',
        tests: 9,
        failed: 1,
        children: [
          suite('total', {
            state: 'fail',
            tests: 3,
            failed: 1,
            children: [test_('applies the discount', 'expected 90')],
            rest: { passed: 2, skipped: 0, todo: 0, durationMs: 3 },
          }),
          suite('empty'),
        ],
      }),
    ],
  }),
  passing('src/b/more.test.ts', { kind: 'skip', tests: 2, skipped: 2 }),
]

function lines(
  files: readonly TreeFile[],
  columns = 80,
  set: 'emoji' | 'ascii' | 'unicode' = 'emoji',
  style = plain,
) {
  return treeLines(groupByFolder(files), columns, GLYPHS[set], style)
}

describe('the tree', () => {
  test('a folder is a heading with its totals; a file that fully passed is one folded row', () => {
    const out = lines([passing('src/a/ok.test.ts')])
    assert.equal(out.length, 2)
    assert.match(out[0] as string, /^✅ src\/a\/ · 1 file · 4 tests +12ms$/)
    assert.match(out[1] as string, /^└─ ✅ ok\.test\.ts · 4 tests +12ms$/)
  })

  test('a file with a failure opens: suites and the failed test with the first line of its error', () => {
    const out = lines(SAMPLE, 80)
    assert.deepEqual(
      out.map((line) => line.replace(/ +\d+ms$/, '').trimEnd()),
      [
        '❌ src/a/ · 2 files · 13 tests · 1 failed',
        '├─ ❌ bad.test.ts · 1 of 9 failed',
        '│  └─ ❌ cart · 1 of 9 failed',
        '│     ├─ ❌ total · 1 of 3 failed',
        '│     │  ├─ ❌ applies the discount',
        '│     │  │     expected 90',
        '│     │  └─ ✅ 2 more tests',
        '│     └─ ✅ empty · 2 tests',
        '└─ ✅ ok.test.ts · 4 tests',
        '✅ src/b/ · 1 file · 2 tests',
        '└─ ⏩ more.test.ts · 2 tests skipped',
      ],
    )
  })

  test('every row with a time ends in the last column, whatever the glyph widths', () => {
    for (const set of ['emoji', 'unicode', 'ascii'] as const) {
      for (const columns of [40, 80, 120]) {
        for (const line of lines(SAMPLE, columns, set)) {
          if (!/\d+ms$/.test(line)) continue
          assert.equal(displayWidth(line), columns - 1, `${set} ${columns}: ${line}`)
        }
      }
    }
  })

  test('no row is wider than the terminal less one column, even a long name at a narrow width', () => {
    const long = failing('a/' + 'x'.repeat(120) + '.test.ts', {
      children: [test_('a'.repeat(200), 'm'.repeat(300))],
      messages: ['e'.repeat(300)],
      moreFailed: 3,
    })
    for (const columns of [12, 20, 40, 80]) {
      for (const line of lines([long, ...SAMPLE], columns)) {
        assert.ok(displayWidth(line) <= columns - 1, `${columns}: ${line}`)
      }
    }
  })

  test('a long name is cut with an ellipsis and the time stays at the right edge', () => {
    const out = lines([passing(`a/${'n'.repeat(100)}.test.ts`)], 40)
    const row = out[1] as string
    assert.ok(row.includes('…'))
    assert.match(row, /12ms$/)
    assert.equal(displayWidth(row), 39)
  })

  test('the ASCII set draws with |- \\- and |; the box set with ├─ └─ and │', () => {
    const ascii = lines(SAMPLE, 80, 'ascii')
    assert.ok(ascii.some((line) => line.startsWith('|- ')))
    assert.ok(ascii.some((line) => line.startsWith('\\- ')))
    assert.ok(ascii.some((line) => line.startsWith('|  \\- ')))
    assert.ok(ascii.every((line) => !/[├└│─]/.test(line)))
    const unicode = lines(SAMPLE, 80, 'unicode')
    assert.ok(unicode.some((line) => line.startsWith('├─ ')))
    assert.ok(unicode.some((line) => line.startsWith('│  └─ ')))
    assert.ok(unicode.every((line) => !line.includes('✅')))
  })

  test('the failed rows are red and the guides and details dim under colour; plain text has no escape', () => {
    const out = lines(SAMPLE, 80, 'emoji', colour)
    const failed = out.find((line) => line.includes('applies the discount')) as string
    assert.ok(failed.includes('\u001b[31mapplies the discount\u001b[39m'))
    assert.ok(failed.includes('\u001b[2m'))
    assert.ok(lines(SAMPLE, 80).every((line) => !line.includes('\u001b')))
  })

  test('a name with a newline or an escape sequence is one clean line', () => {
    const out = lines(
      [
        failing('a/x.test.ts', {
          children: [test_('first\nsecond \u001b[2J\u001b[1;1H gone', 'one\ntwo\r\nthree')],
        }),
      ],
      120,
    )
    assert.equal(out.length, 4)
    assert.ok(out.every((line) => !line.includes('\u001b') && !line.includes('\n')))
    assert.ok(out[2]?.includes('first second  gone'))
    assert.ok(out[3]?.includes('one two three'))
  })

  test('a file’s own errors go under its row; failed tests past the budget are one counted row', () => {
    const out = lines(
      [
        failing('a/x.test.ts', {
          messages: ['ImportError: cannot find ./y'],
          children: [test_('t', 'boom')],
          moreFailed: 12,
        }),
      ],
      100,
    )
    assert.match(out[2] as string, /^ {6}ImportError: cannot find .\/y$/)
    assert.match(out[3] as string, /^ {3}├─ ❌ t\b/)
    assert.equal(out.at(-1)?.trimEnd(), '   └─ … 12 more failed tests')
  })

  test('a folded suite is one row with its count; a suite with only todo tests says so', () => {
    const out = lines(
      [
        failing('a/x.test.ts', {
          children: [
            suite('later', { state: 'todo', tests: 1, skipped: 1 }),
            suite('off', { state: 'skip', tests: 3, skipped: 3 }),
            test_('t'),
          ],
        }),
      ],
      100,
    )
    assert.match(out[2] as string, /^ {3}├─ 📝 later · 1 test · 1 skipped +3ms$/)
    assert.match(out[3] as string, /^ {3}├─ ⏩ off · 3 tests skipped +3ms$/)
  })

  test('the row for tests that are not listed names each part', () => {
    const rest = { passed: 5, skipped: 2, todo: 1, durationMs: 9 }
    const out = lines([failing('a/x.test.ts', { children: [test_('t')], rest })], 100)
    assert.match(out.at(-1) as string, /^ {3}└─ ✅ 5 more tests · 2 skipped · 1 todo +9ms$/)
    const only = lines(
      [
        failing('a/x.test.ts', {
          children: [],
          rest: { passed: 0, skipped: 0, todo: 2, durationMs: 1 },
        }),
      ],
      100,
    )
    assert.match(only.at(-1) as string, /└─ 📝 2 todo +1ms$/)
  })

  test('a project’s name goes before its folder, and a root file’s folder is ./', () => {
    assert.equal(folderLabel({ project: '', dir: '.' }), './')
    assert.equal(folderLabel({ project: 'web', dir: 'src/a' }), 'web src/a/')
    assert.equal(folderLabel({ project: '', dir: '/' }), '/')
    const out = lines([passing('top.test.ts', { project: 'web' })])
    assert.match(out[0] as string, /^✅ web \.\/ · 1 file/)
  })

  test('a folder with a failed file shows ❌, even when no test of it failed', () => {
    const out = lines([failing('a/x.test.ts', { messages: ['could not collect'] })])
    assert.ok(out[0]?.startsWith('❌ a/ · 1 file'))
  })

  test('no files, no lines', () => {
    assert.deepEqual(lines([]), [])
  })
})
