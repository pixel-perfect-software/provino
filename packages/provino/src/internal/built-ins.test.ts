import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { NATIVE_RUNTIME } from './built-ins.ts'

describe('NATIVE_RUNTIME', () => {
  test('every ref is an absolute file: URL whose module has the named export (D21)', async () => {
    const { moduleScope, globals, matcherTable } = NATIVE_RUNTIME
    for (const ref of [moduleScope, globals, matcherTable]) {
      assert.ok(ref.module.startsWith('file:'), ref.module)
      const loaded: unknown = await import(ref.module)
      assert.equal(typeof Reflect.get(loaded as object, ref.export), 'function', ref.export)
    }
    assert.deepEqual(NATIVE_RUNTIME.modules, ['provino'])
  })
})
