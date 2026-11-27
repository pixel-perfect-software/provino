import assert from 'node:assert/strict'
import { PROVINO_SERVED_MODULE } from '@provino/api'
import { describe, test } from 'provino'
import { NATIVE_RUNTIME } from './built-ins.ts'

describe('NATIVE_RUNTIME', () => {
  test("the snapshot printer writes Jest's format, and the inline writer is the native one (B28)", async () => {
    const { printer, writer } = NATIVE_RUNTIME.snapshot ?? {}
    assert.equal(writer?.export, 'nativeInlineSnapshotWriter')
    assert.equal(writer?.module, import.meta.resolve('@provino/snapshot/inline'))
    const loaded = (await import(printer?.module ?? '')) as Record<string, unknown>
    const factory = loaded[printer?.export ?? ''] as () => {
      serialize(value: unknown, options: { format: object; plugins: never[] }): string
    }
    assert.equal(
      factory().serialize({ a: [1] }, { format: {}, plugins: [] }),
      'Object {\n  "a": Array [\n    1,\n  ],\n}',
    )
  })

  test('every ref is an absolute file: URL whose module has the named export (D21)', async () => {
    const { moduleScope, globals, matcherTable, snapshot } = NATIVE_RUNTIME
    const { printer, writer } = snapshot ?? {}
    assert.ok(printer !== undefined, 'the native runtime has a snapshot printer (B28)')
    assert.ok(writer !== undefined, 'the native runtime has an inline snapshot writer (B28)')
    for (const ref of [moduleScope, globals, matcherTable, printer, writer]) {
      assert.ok(ref.module.startsWith('file:'), ref.module)
      const loaded: unknown = await import(ref.module)
      assert.equal(typeof Reflect.get(loaded as object, ref.export), 'function', ref.export)
    }
    assert.deepEqual(NATIVE_RUNTIME.modules, ['provino'])
  })

  test('the served module, the API that serves it and the hoisted mocks name one specifier', () => {
    const { modules, hoist } = NATIVE_RUNTIME
    assert.deepEqual(modules, [PROVINO_SERVED_MODULE])
    assert.deepEqual(hoist?.runnerModules, modules)
    assert.deepEqual(new Set(hoist?.importedCalls?.map((call) => call.module)), new Set(modules))
    // The isolation callbacks hoist a `mock` of their own (B28), from the same served module.
    assert.deepEqual(new Set(hoist?.callbackScopes?.map((call) => call.module)), new Set(modules))
  })
})
