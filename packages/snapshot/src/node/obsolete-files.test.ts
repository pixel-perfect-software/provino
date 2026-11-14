import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { defaultSnapshotPath } from '@provino/snapshot'
import { cleanObsoleteSnapshotFiles, defaultSnapshotTestPath } from './obsolete-files.ts'

const LAYOUT = { dirName: '__snapshots__', extension: '.snap' }

function tree(files: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'provino-obsolete-'))
  after(() => rmSync(root, { recursive: true, force: true }))
  for (const file of files) {
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), '')
  }
  return root
}

const options = (root: string) => ({
  roots: [root],
  extension: '.snap',
  crawlIgnorePatterns: [],
  testPathIgnorePatterns: [],
  testPathOf: (path: string) => defaultSnapshotTestPath(path, LAYOUT),
  update: 'new' as const,
})

describe('defaultSnapshotTestPath', () => {
  test('inverts defaultSnapshotPath', () => {
    const test = '/p/src/a.test.ts'
    assert.equal(defaultSnapshotTestPath(defaultSnapshotPath(test, LAYOUT), LAYOUT), test)
  })

  test('takes the parent of the snapshot`s directory, whatever it is called (Jest`s default)', () => {
    assert.equal(defaultSnapshotTestPath('/p/snaps/b.test.ts.snap', LAYOUT), '/p/b.test.ts')
  })
})

describe('cleanObsoleteSnapshotFiles', () => {
  test('reports the snapshot files whose test file is not there, sorted, and keeps them', () => {
    const root = tree([
      'kept.test.ts',
      '__snapshots__/kept.test.ts.snap',
      '__snapshots__/gone.test.ts.snap',
      'sub/__snapshots__/also-gone.test.ts.snap',
    ])
    const found = cleanObsoleteSnapshotFiles(options(root))
    assert.deepEqual(found, [
      join(root, '__snapshots__/gone.test.ts.snap'),
      join(root, 'sub/__snapshots__/also-gone.test.ts.snap'),
    ])
    assert.ok(found.every((file) => existsSync(file)))
  })

  test('under `all` it deletes them', () => {
    const root = tree(['__snapshots__/gone.test.ts.snap'])
    const [gone] = cleanObsoleteSnapshotFiles({ ...options(root), update: 'all' })
    assert.ok(gone !== undefined && !existsSync(gone))
  })

  test('a test path an ignore pattern matches is left alone, so is node_modules and a crawl-ignored path', () => {
    const root = tree([
      'ignored/__snapshots__/a.test.ts.snap',
      'node_modules/pkg/__snapshots__/b.test.ts.snap',
      'build/__snapshots__/c.test.ts.snap',
      '__snapshots__/d.test.ts.snap',
    ])
    const found = cleanObsoleteSnapshotFiles({
      ...options(root),
      crawlIgnorePatterns: ['/build/'],
      testPathIgnorePatterns: ['/ignored/'],
    })
    assert.deepEqual(found, [join(root, '__snapshots__/d.test.ts.snap')])
  })

  test('a symlinked directory is not followed, and other extensions are not snapshot files', () => {
    const root = tree(['real/__snapshots__/a.test.ts.snap', '__snapshots__/b.test.ts.shot'])
    symlinkSync(join(root, 'real'), join(root, 'link'))
    assert.deepEqual(cleanObsoleteSnapshotFiles(options(root)), [
      join(root, 'real/__snapshots__/a.test.ts.snap'),
    ])
  })

  test('a resolver`s inverse decides the test file', () => {
    const root = tree(['t/a.test.ts', '__snaps__/a.test.ts.snap', '__snaps__/b.test.ts.snap'])
    const found = cleanObsoleteSnapshotFiles({
      ...options(root),
      testPathOf: (path) => join(root, 't', path.slice(path.lastIndexOf('/') + 1, -'.snap'.length)),
    })
    assert.deepEqual(found, [join(root, '__snaps__/b.test.ts.snap')])
  })
})
