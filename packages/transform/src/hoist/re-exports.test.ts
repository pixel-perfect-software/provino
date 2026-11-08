// `reExports`: what happens to `export … from` when a call hoists. `in-order` loads each in source
// order with the imports (Babel's CJS step); `static` leaves them as written (Vitest's hoistMocks).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TransformRecord } from '@provino/types'
import { toModuleRunner } from '../module-runner.ts'
import { assertOrder, hoist } from './test-helpers.ts'
import { blockPolicy, topLevelPolicy } from './test-policies.ts'

const SOURCE =
  "export * from './a'\nimport { foo } from './foo'\nexport { q as r } from './q'\nexport * from './b'\nuse(foo)\njest.mock('./m')\n"
const STATIC = { ...blockPolicy, reExports: 'static' } as const

test('re-exports: in-order loads every export-from with the imports, in source order', () => {
  const result = hoist(SOURCE, blockPolicy)
  assert.equal(result.rewroteImports, true)
  assertOrder(
    result.code,
    "jest.mock('./m')",
    'await import("./a")',
    'await import("./foo")',
    'await import("./q")',
    'await import("./b")',
  )
  assert.ok(!result.code.includes('export * from'))
  assert.ok(!result.code.includes('from "./q"'))
})

test('re-exports: static leaves every export-from exactly as written', () => {
  const result = hoist(SOURCE, STATIC)
  assert.ok(result.code.includes("export * from './a'"))
  assert.ok(result.code.includes("export { q as r } from './q'"))
  assert.ok(result.code.includes("export * from './b'"))
  assert.ok(!result.code.includes('__vite_ssr_exportAll__'))
  assert.ok(!result.code.includes('__vite_ssr_exports__'))
  assertOrder(result.code, "jest.mock('./m')", 'await import("./foo")')
  assert.ok(result.code.includes('use(__provino_import_0__.foo)'))
})

test('re-exports: static does not count export-from as an import to rewrite', () => {
  const result = hoist(
    "export * from './a'\nexport { q } from './q'\nvi.mock('./m')\n",
    topLevelPolicy,
  )
  assert.equal(result.rewroteImports, false)
  assertOrder(result.code, "vi.mock('./m')", "export * from './a'")
})

test('re-exports: static still rewrites export { x } of an imported binding', () => {
  const result = hoist("import { x } from './a'\nexport { x }\nvi.mock('./m')\n", topLevelPolicy)
  assert.ok(result.code.includes('__vite_ssr_exports__, "x"'))
  assert.ok(!result.code.includes('export { x }'))
})

test('re-exports: static output survives the module-runner transform', () => {
  const result = hoist(SOURCE, STATIC)
  const record = {
    code: result.code,
    map: result.map,
  } as unknown as TransformRecord
  const output = toModuleRunner('/m.js', record)
  assert.ok(output.deps.includes('./a'), 'the re-exported module is a static dependency')
  assert.ok(output.dynamicDeps.includes('./foo'))
})

test('re-exports: in-order output survives the module-runner transform', () => {
  const result = hoist(SOURCE, blockPolicy)
  const record = {
    code: result.code,
    map: result.map,
  } as unknown as TransformRecord
  const output = toModuleRunner('/m.js', record)
  assert.deepEqual(output.deps, [])
  assert.deepEqual([...output.dynamicDeps].sort(), ['./a', './b', './foo', './q'])
})
