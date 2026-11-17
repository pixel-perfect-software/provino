import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  type FolderFile,
  fileKind,
  folderDetail,
  folderLabel,
  groupByFolder,
  outcomeOf,
} from './folders.ts'

function file(path: string, extra: Partial<FolderFile> = {}): FolderFile {
  return {
    path,
    project: '',
    kind: 'pass',
    tests: 1,
    failed: 0,
    skipped: 0,
    durationMs: 10,
    ...extra,
  }
}

describe('how a set of tests ended', () => {
  test('a failure fails; all todo is todo; all skipped is skip; the rest pass', () => {
    assert.equal(outcomeOf(3, 1, 0, 0), 'fail')
    assert.equal(outcomeOf(3, 1, 3, 3), 'fail', 'a failure beats the rest')
    assert.equal(outcomeOf(2, 0, 2, 2), 'todo')
    assert.equal(outcomeOf(2, 0, 2, 1), 'skip', 'skipped and todo together are skipped')
    assert.equal(outcomeOf(2, 0, 2, 0), 'skip')
    assert.equal(outcomeOf(3, 0, 1, 1), 'pass')
    assert.equal(outcomeOf(0, 0, 0, 0), 'pass', 'no test, nothing to say')
  })
})

describe('the kind of a file', () => {
  test('a failed file fails; a file of only todo tests is todo; a skipped one skips; the rest pass', () => {
    assert.equal(fileKind('fail', 3, 3, 3), 'fail')
    assert.equal(fileKind('pass', 2, 2, 2), 'todo')
    assert.equal(fileKind('skip', 2, 2, 2), 'todo')
    assert.equal(fileKind('skip', 2, 2, 0), 'skip')
    assert.equal(fileKind('skip', 0, 0, 0), 'skip', 'skipped whole with no test to say so')
    assert.equal(fileKind('pass', 3, 1, 1), 'pass')
    assert.equal(fileKind('pass', 0, 0, 0), 'pass')
  })
})

describe('a folder’s label and heading', () => {
  test('the project, then the directory with a closing slash', () => {
    assert.equal(folderLabel({ project: '', dir: '.' }), './')
    assert.equal(folderLabel({ project: 'web', dir: 'src/a' }), 'web src/a/')
    assert.equal(folderLabel({ project: '', dir: '/' }), '/')
  })

  test('files and tests, and the failed tests when there are some', () => {
    const [ok] = groupByFolder([file('a/x.ts')])
    assert.equal(ok && folderDetail(ok), '1 file · 1 test')
    const [bad] = groupByFolder([
      file('b/x.ts', { tests: 1200, failed: 3 }),
      file('b/y.ts', { tests: 4 }),
    ])
    assert.equal(bad && folderDetail(bad), '2 files · 1,204 tests · 3 failed')
  })
})

describe('grouping files by folder', () => {
  test('folders in directory order, files in path order, with totals and time', () => {
    const files = [
      file('src/b/z.test.ts', { tests: 2, durationMs: 5 }),
      file('top.test.ts', { durationMs: 1 }),
      file('src/b/a.test.ts', { kind: 'fail', tests: 3, failed: 2, skipped: 1, durationMs: 20 }),
      file('src/a/m.test.ts', { durationMs: 7 }),
    ]
    const folders = groupByFolder(files)
    assert.deepEqual(
      folders.map((folder) => folder.dir),
      ['.', 'src/a', 'src/b'],
    )
    const b = folders[2]
    assert.deepEqual(
      b?.files.map((each) => each.path),
      ['src/b/a.test.ts', 'src/b/z.test.ts'],
    )
    assert.equal(b?.tests, 5)
    assert.equal(b?.failed, 2)
    assert.equal(b?.skipped, 1)
    assert.equal(b?.durationMs, 25)
    assert.equal(b?.filesFailed, 1)
    assert.equal(folders[0]?.filesFailed, 0)
  })

  test('a root file’s folder is `.`, an absolute one’s its directory, and a backslash is part of a name', () => {
    assert.deepEqual(
      groupByFolder([
        file('c.test.ts'),
        file('/c.test.ts'),
        file('/a/c.test.ts'),
        file('a\\b.ts'),
      ]).map((folder) => folder.dir),
      ['.', '/', '/a'],
    )
  })

  test('the input is left as it was', () => {
    const files = [file('b/x.test.ts'), file('a/y.test.ts')]
    const before = JSON.stringify(files)
    groupByFolder(files)
    assert.equal(JSON.stringify(files), before)
  })

  test('two projects keep apart even when their folders share a name', () => {
    const folders = groupByFolder([
      file('src/a.test.ts', { project: 'web' }),
      file('src/a.test.ts', { project: 'api' }),
      file('src/b.test.ts', { project: 'web' }),
    ])
    assert.deepEqual(
      folders.map((folder) => [folder.project, folder.dir, folder.files.length]),
      [
        ['api', 'src', 1],
        ['web', 'src', 2],
      ],
    )
  })

  test('no files, no folders; the order does not depend on the locale', () => {
    assert.deepEqual(groupByFolder([]), [])
    const folders = groupByFolder([file('b/x.ts'), file('B/x.ts'), file('a/x.ts')])
    // Code-unit order: an upper-case letter sorts before a lower-case one.
    assert.deepEqual(
      folders.map((folder) => folder.dir),
      ['B', 'a', 'b'],
    )
  })

  test('a subtype keeps its own fields', () => {
    const folders = groupByFolder([{ ...file('a/x.ts'), extra: 7 }])
    assert.equal(folders[0]?.files[0]?.extra, 7)
  })
})
