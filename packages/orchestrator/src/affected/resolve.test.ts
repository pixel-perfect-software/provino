import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { indexMocks, isBuiltinSpecifier, resolveEdges } from './resolve.ts'

const FILES = [
  '/p/lib/util.ts',
  '/p/lib/__mocks__/util.ts',
  '/p/lib/__mocks__/deep/inner.ts',
  '/p/__mocks__/virtual.ts',
]
const mockEdges = { dir: '__mocks__', adjacent: true, byName: true }

describe('resolveEdges', () => {
  const resolver = {
    resolveDependency: (specifier: string) =>
      specifier === './util' ? '/p/lib/util.ts' : undefined,
  }

  it('skips builtins, follows the adjacent mock, and finds a root mock of an unresolved name', () => {
    const mocks = indexMocks(FILES, mockEdges)
    assert.deepEqual(
      [
        ...resolveEdges('/p/a.test.ts', ['fs', 'node:path', './util', 'virtual', './nope'], {
          resolver,
          mocks,
          mockEdges,
        }),
      ].sort(),
      ['/p/__mocks__/virtual.ts', '/p/lib/__mocks__/util.ts', '/p/lib/util.ts'],
    )
  })

  it('byName off leaves an unresolved name alone, and adjacent off leaves the mock', () => {
    const off = { dir: '__mocks__', adjacent: false, byName: false }
    assert.deepEqual(
      [
        ...resolveEdges('/p/a.test.ts', ['./util', 'virtual'], {
          resolver,
          mocks: indexMocks(FILES, off),
          mockEdges: off,
        }),
      ],
      ['/p/lib/util.ts'],
    )
  })

  it('a mock in a sub-directory of the mock directory is not an adjacent mock', () => {
    const mocks = indexMocks(FILES, mockEdges)
    assert.equal(mocks.adjacent('/p/lib', 'inner'), undefined)
    assert.equal(mocks.byName('deep/inner'), '/p/lib/__mocks__/deep/inner.ts')
  })

  it('names core modules', () => {
    assert.ok(isBuiltinSpecifier('fs/promises'))
    assert.ok(isBuiltinSpecifier('node:test'))
    assert.ok(!isBuiltinSpecifier('./fs'))
  })
})
