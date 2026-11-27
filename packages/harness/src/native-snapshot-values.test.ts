// NN2 for the native snapshot slice (B28, D211): `nativeSnapshotPolicy` claims Jest 30.5's `.snap`
// format, so its format keys must be `jestPolicy.snapshot`'s, whose values the Jest corpus holds
// to real Jest. The key function is the one the neutral policy and Jest's slice both resolve to.
// The snapshot corpus's `native` profile holds the bytes end to end.
import assert from 'node:assert/strict'
import { jestPolicy } from '@provino/dialect-jest'
import { moduleRef, nativeSnapshotPolicy, resolvePolicy } from '@provino/policy'
import type { SnapshotPrinterFactory } from '@provino/types'
import { describe, test } from 'provino'

const printer = moduleRef<SnapshotPrinterFactory>(
  'file:///native/printer.mjs',
  'nativeSnapshotPrinter',
)
const native = nativeSnapshotPolicy({ printer })
const jest = jestPolicy.snapshot

describe('nativeSnapshotPolicy against jestPolicy.snapshot', () => {
  test("the header, the joins and the pretty-format options are Jest's", () => {
    assert.ok(jest !== undefined)
    assert.equal(native.header, jest.header)
    assert.equal(native.keyJoin, jest.keyJoin)
    assert.equal(native.hintJoin, jest.hintJoin)
    assert.deepEqual(native.format, jest.format)
  })

  test('the key function a native project resolves is the one a Jest project resolves', () => {
    const resolvedNative = resolvePolicy({ snapshot: native }).snapshot
    const resolvedJest = resolvePolicy(jestPolicy).snapshot
    assert.deepEqual(resolvedNative.key, resolvedJest.key)
    assert.deepEqual(resolvedNative.dirName, resolvedJest.dirName)
    assert.deepEqual(resolvedNative.extension, resolvedJest.extension)
  })

  test("the obsolete rule and the inline indent are Jest's", () => {
    assert.ok(jest !== undefined)
    assert.deepEqual(native.obsolete, jest.obsolete)
    assert.equal(native.inline?.indent, jest.inline?.indent)
  })

  test("the printer is the native one, never the Jest dialect's", () => {
    assert.deepEqual(native.printer, printer)
    assert.notDeepEqual(native.printer, jest?.printer)
  })
})
