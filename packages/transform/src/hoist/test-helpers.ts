// Shared by the hoist engine's tests.
import assert from 'node:assert/strict'
import type { HoistPolicy, Pipeline } from '@provino/types'
import { createPipeline } from '../pipeline.ts'
import { type HoistOutput, hoistMocks } from './index.ts'
import { blockPolicy } from './test-policies.ts'

export function hoist(code: string, policy: HoistPolicy): HoistOutput {
  return hoistMocks(code, policy, { filename: 'case.js' })
}

/** The real pipeline under `blockPolicy`, with no tsconfig to find. */
export function blockPipeline(): Pipeline {
  return createPipeline({
    root: '/virtual',
    typescript: 'oxc',
    tsconfig: false,
    hoist: blockPolicy,
    cache: false,
  })
}

/** Asserts each needle occurs in `code`, in the given order. */
export function assertOrder(code: string, ...needles: string[]): void {
  let last = -1
  for (const needle of needles) {
    const at = code.indexOf(needle, last + 1)
    assert.ok(at > last, `expected ${JSON.stringify(needle)} after position ${last} in:\n${code}`)
    last = at
  }
}

/** Asserts a case hoisted nothing and left the code alone. */
export function assertUntouched(code: string, result: HoistOutput): void {
  assert.equal(result.code, code)
  assert.equal(result.map, null)
  assert.deepEqual(result.diagnostics, [])
  assert.equal(result.rewroteImports, false)
}

/** The error codes of a result, in order. */
export function errorCodes(result: HoistOutput): string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code)
}
