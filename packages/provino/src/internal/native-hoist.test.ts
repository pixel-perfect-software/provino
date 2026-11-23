// The hoister under the native runtime's own policy (`NATIVE_RUNTIME.hoist`, B27j): what a native
// test file becomes. The factories' reads are run end to end in `test/native-mocks.test.ts`.
import assert from 'node:assert/strict'
import { describe, test } from 'provino'
import { hoistMocks } from '@provino/transform'
import type { HoistPolicy } from '@provino/types'
import { NATIVE_RUNTIME } from './built-ins.ts'

function nativeHoist(): HoistPolicy {
  const { hoist } = NATIVE_RUNTIME
  if (hoist === undefined) throw new Error('NATIVE_RUNTIME has no hoist policy')
  return hoist
}
const policy = nativeHoist()

function hoisted(code: string): string {
  const result = hoistMocks(code, policy, { filename: 'case.test.ts' })
  assert.deepEqual(result.diagnostics, [])
  return result.code
}

/** Asserts each needle occurs in `code`, in the given order. */
function assertOrder(code: string, ...needles: string[]): void {
  let last = -1
  for (const needle of needles) {
    const at = code.indexOf(needle, last + 1)
    assert.ok(at > last, `expected ${JSON.stringify(needle)} after position ${last} in:\n${code}`)
    last = at
  }
}

describe('the native hoist policy', () => {
  test('a factory reading an earlier import keeps it before the mocked import', () => {
    const code = hoisted(
      "import { mock } from 'provino'\nimport { b } from './b'\nimport { a } from './a'\nmock('./a', () => ({ a: b }))\nuse(a)\n",
    )
    assertOrder(
      code,
      "import { mock } from 'provino'",
      "mock('./a', () => ({ a: __provino_import_0__.b }))",
      '__provino_import_0__ = await __provino_import__("./b")',
      '__provino_import_1__ = await __provino_import__("./a")',
      'use(__provino_import_1__.a)',
    )
  })

  test('a factory reading a later import or a top-level binding is hoisted as written (the API names it when it runs)', () => {
    const later = hoisted(
      "import { mock } from 'provino'\nimport { a } from './a'\nimport { b } from './b'\nmock('./a', () => ({ a: b }))\n",
    )
    assertOrder(
      later,
      "mock('./a', () => ({ a: __provino_import_1__.b }))",
      '__provino_import_0__ = await __provino_import__("./a")',
      '__provino_import_1__ = await __provino_import__("./b")',
    )
    const own = hoisted(
      "import { mock } from 'provino'\nimport { a } from './a'\nconst m = 1\nmock('./a', () => ({ a: m }))\n",
    )
    assertOrder(own, "mock('./a', () => ({ a: m }))", '__provino_import__("./a")', 'const m = 1')
  })

  test('a mocked module re-exported with export … from loads after the mock (in-order)', () => {
    const code = hoisted(
      "import { mock } from 'provino'\nexport { a } from './a'\nmock('./a', () => ({ a: 1 }))\n",
    )
    assertOrder(code, "mock('./a'", '__provino_import__("./a")')
    assert.doesNotMatch(code, /export \{ a \} from/)
  })

  test('a call through a rewritten import is detached: `this` is undefined, as in ES modules', () => {
    const code = hoisted(
      "import { mock } from 'provino'\nimport { f } from './f'\nmock('./g')\nf()\n",
    )
    assert.match(code, /\(0, __provino_import_0__\.f\)\(\)/)
  })

  test('the provino import stays static and first', () => {
    const code = hoisted(
      "import { fn, mock } from 'provino'\nimport { a } from './a'\nmock('./a')\n",
    )
    assert.ok(code.startsWith("import { fn, mock } from 'provino'"), code)
  })
})
