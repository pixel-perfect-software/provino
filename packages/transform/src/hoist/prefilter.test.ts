// The prefilter's regex for a policy with a global or bare-name mock object (the dialects') is
// pinned byte for byte as it was before `importedCalls` (B27j): only an import-only policy got the
// specifier gate. The two policies here have the shape of Jest's and Vitest's hoisting policies
// (their names, objects and argument lists); the real ones live in the dialects, which this layer
// can't import. `packages/harness`'s hoist corpus runs the real ones.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HoistPolicy } from '@provino/types'
import { prefilterFor } from './prefilter.ts'
import { blockPolicy, topLevelPolicy } from './test-policies.ts'

const jestShaped: HoistPolicy = {
  ...blockPolicy,
  id: 'jest-shaped',
  hoistCalls: {
    mock: 'path-factory-options',
    unmock: 'one-string',
    deepUnmock: 'one-string',
    enableAutomock: 'no-args',
    disableAutomock: 'no-args',
  },
}

const vitestShaped: HoistPolicy = { ...topLevelPolicy, id: 'vitest-shaped' }

test('the regex of a policy with a global or a name matcher is unchanged', () => {
  const jest = prefilterFor(jestShaped)
  const vitest = prefilterFor(vitestShaped)
  assert.ok(jest instanceof RegExp && vitest instanceof RegExp)
  assert.equal(
    jest.source,
    '\\b(?:mock|unmock|deepUnmock|enableAutomock|disableAutomock)(?:\\s|\\/\\/[^\\n\\r]*|\\/\\*[^*]*\\*+(?:[^/*][^*]*\\*+)*\\/)*\\(|\\\\u',
  )
  assert.equal(
    vitest.source,
    '\\b(?:mock|unmock|hoisted|doMock|doUnmock)(?:\\s|\\/\\/[^\\n\\r]*|\\/\\*[^*]*\\*+(?:[^/*][^*]*\\*+)*\\/)*\\(|\\\\u',
  )
})

test('a dialect-shaped prefilter still fires without any module named', () => {
  assert.equal(prefilterFor(vitestShaped)?.test("foo()\\nvi.mock('./a')\\n"), true)
})
