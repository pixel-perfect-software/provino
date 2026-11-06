import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { findManualMock, findRootMock, isCoreSpecifier } from './manual-mocks.ts'

const dir = mkdtempSync(join(tmpdir(), 'provino-manual-'))
after(() => rmSync(dir, { recursive: true, force: true }))

function write(path: string): string {
  const file = join(dir, path)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, '')
  return file
}

const pkg = write('__mocks__/pkg.js')
const scoped = write('__mocks__/@scope/lib.ts')
const os = write('__mocks__/os.ts')
const adjacent = write('src/__mocks__/x.ts')
const x = write('src/x.ts')
const y = write('src/y.ts')
const options = { roots: [dir], extensions: ['.ts', 'js'] }

describe('findManualMock', () => {
  test('a root mock for a plain and a scoped package, with extensions given with or without a dot', () => {
    assert.deepEqual(findManualMock('pkg', options), { path: pkg, kind: 'root' })
    assert.deepEqual(findManualMock('@scope/lib', options), { path: scoped, kind: 'root' })
  })

  test('a core name finds __mocks__/os under both spellings', () => {
    assert.deepEqual(findManualMock('os', options), { path: os, kind: 'root' })
    assert.deepEqual(findManualMock('node:os', options), { path: os, kind: 'root' })
  })

  test('an adjacent mock sits beside the resolved file', () => {
    assert.deepEqual(findManualMock('./x', { ...options, resolved: x }), {
      path: adjacent,
      kind: 'adjacent',
    })
    assert.equal(findManualMock('./y', { ...options, resolved: y }), null)
  })

  test('a root mock is found first, the first root wins, and a relative specifier has no root mock', () => {
    const other = mkdtempSync(join(tmpdir(), 'provino-manual-b-'))
    try {
      assert.deepEqual(findManualMock('pkg', { ...options, roots: [other, dir] }), {
        path: pkg,
        kind: 'root',
      })
      assert.equal(findRootMock('./pkg', options), null)
      assert.equal(findRootMock('/abs/pkg', options), null)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  test('nothing found is null, and a core module has no adjacent mock', () => {
    assert.equal(findManualMock('nothing', options), null)
    assert.equal(findManualMock('fs', { ...options, resolved: x }), null)
  })

  test('isCoreSpecifier', () => {
    assert.equal(isCoreSpecifier('fs'), true)
    assert.equal(isCoreSpecifier('node:test'), true)
    assert.equal(isCoreSpecifier('pkg'), false)
  })
})
