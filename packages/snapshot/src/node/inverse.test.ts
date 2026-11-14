import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultSnapshotPath } from '../paths.ts'
import { testPathOfSnapshot } from './index.ts'

const layout = { dirName: '__snapshots__', extension: '.snap' }

test('the inverse of the default snapshot path', () => {
  for (const testFile of ['/p/a.test.ts', '/p/deep/dir/b.spec.js', '/p/x.y.z.test.tsx']) {
    assert.equal(testPathOfSnapshot(defaultSnapshotPath(testFile, layout), layout), testFile)
  }
})

test('a path that is not a snapshot at the default location has no test', () => {
  assert.equal(testPathOfSnapshot('/p/a.test.ts.snap', layout), undefined)
  assert.equal(testPathOfSnapshot('/p/__snapshots__/a.test.ts', layout), undefined)
  assert.equal(testPathOfSnapshot('/p/__snapshots__/.snap', layout), undefined)
  assert.equal(testPathOfSnapshot('/p/other/a.test.ts.snap', layout), undefined)
})

test('a layout of its own', () => {
  const own = { dirName: 'snaps', extension: '.shot' }
  assert.equal(testPathOfSnapshot('/p/snaps/a.test.ts.shot', own), '/p/a.test.ts')
})
