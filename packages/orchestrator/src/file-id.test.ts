import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { fileIdOf } from './file-id.ts'

describe('fileIdOf', () => {
  test('is the first ten hex digits of the SHA-1 over <project>\\0<path>', () => {
    // Computed outside Node: printf 'bench\0a/b.test.js' | openssl sha1
    assert.equal(fileIdOf('bench', 'a/b.test.js'), '281614a0a4')
    assert.equal(fileIdOf('', 'x.test.ts'), '492dccf30e')
    assert.equal(fileIdOf('web', 'src/deep/a.test.ts'), '2c3425d1e1')
  })

  test('is the same for the same project and path', () => {
    assert.equal(fileIdOf('web', 'a/b.test.ts'), fileIdOf('web', 'a/b.test.ts'))
  })

  test('differs by project name and by path', () => {
    const base = fileIdOf('web', 'a/b.test.ts')
    assert.notEqual(base, fileIdOf('api', 'a/b.test.ts'))
    assert.notEqual(base, fileIdOf('web', 'a/c.test.ts'))
  })

  test('does not confuse a project name and a path that join to the same text', () => {
    assert.notEqual(fileIdOf('ab', 'c'), fileIdOf('a', 'bc'))
  })
})
