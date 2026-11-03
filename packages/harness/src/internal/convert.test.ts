import assert from 'node:assert/strict'
import { test } from 'node:test'
import { identityAllocator, toRelativePath } from './convert.ts'

test('toRelativePath: POSIX paths become relative to the root; relative ones are only re-slashed', () => {
  assert.equal(toRelativePath('/work/fixture', '/work/fixture/sub/a.test.ts'), 'sub/a.test.ts')
  assert.equal(toRelativePath('/work/fixture', 'sub\\a.test.ts'), 'sub/a.test.ts')
  assert.equal(toRelativePath('/work/fixture', 'a.test.ts'), 'a.test.ts')
})

test('toRelativePath: Windows paths are made relative with Windows rules on any host', () => {
  assert.equal(
    toRelativePath('C:\\work\\fixture', 'C:\\work\\fixture\\sub\\a.test.ts'),
    'sub/a.test.ts',
  )
  assert.equal(toRelativePath('C:\\work\\fixture', 'c:\\WORK\\fixture\\a.test.ts'), 'a.test.ts')
  assert.equal(toRelativePath('C:/work/fixture', 'C:\\work\\fixture\\a.test.ts'), 'a.test.ts')
  assert.equal(
    toRelativePath('C:\\work\\fixture', 'C:/work/fixture/sub/a.test.ts'),
    'sub/a.test.ts',
  )
  assert.equal(
    toRelativePath('\\\\server\\share\\fx', '\\\\server\\share\\fx\\a.test.ts'),
    'a.test.ts',
  )
})

test('identityAllocator counts duplicates over the same title path, not over how it prints', () => {
  const allocate = identityAllocator('a.test.ts')
  assert.equal(allocate(['a', 'b']).dupIndex, 0)
  assert.equal(allocate(['a › b']).dupIndex, 0, 'one title that looks like a path is another path')
  assert.equal(allocate(['a', 'b']).dupIndex, 1)
  assert.equal(allocate(['a › b']).dupIndex, 1)
  assert.equal(allocate(['a', 'c']).dupIndex, 0)
  assert.equal(allocate(['a\\', 'b']).dupIndex, 0, 'a backslash is not an escape of the separator')
  assert.equal(allocate(['a\\ › b']).dupIndex, 0)
})
