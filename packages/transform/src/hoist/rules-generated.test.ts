// Names the transform generated (JSX and lowering helpers) are not out-of-scope factory references,
// because real Jest's plugin sees the code before it is lowered.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hoistMocks } from './index.ts'
import { errorCodes } from './test-helpers.ts'
import { blockPolicy as policy } from './test-policies.ts'

const GENERATED =
  "import { jsxDEV as _jsxDEV } from 'react/jsx-dev-runtime'\njest.mock('./App', () => () => _jsxDEV('div', {}))\n"
const AUTHORED = "jest.mock('./App', () => () => _jsxDEV('div', {}))\n"

test('generated: a name the transform made is allowed when the original lacks it', () => {
  const result = hoistMocks(GENERATED, policy, {
    filename: 'case.js',
    original: "jest.mock('./App', () => () => <div />)\n",
  })
  assert.deepEqual(result.diagnostics, [])
  assert.equal(result.rewroteImports, true)
})

test('generated: a name the original also contains stays out of scope', () => {
  const result = hoistMocks(AUTHORED, policy, { filename: 'case.js', original: AUTHORED })
  assert.deepEqual(errorCodes(result), ['HOIST_FACTORY_OUT_OF_SCOPE'])
})

test('generated: without the original nothing extra is allowed', () => {
  assert.deepEqual(errorCodes(hoistMocks(AUTHORED, policy, { filename: 'case.js' })), [
    'HOIST_FACTORY_OUT_OF_SCOPE',
  ])
})

test('generated: a longer identifier in the original does not hide a generated name', () => {
  const result = hoistMocks(AUTHORED, policy, {
    filename: 'case.js',
    original: "jest.mock('./App', () => () => <div />)\nconst _jsxDEVELOPER = 1\n",
  })
  assert.deepEqual(result.diagnostics, [])
})
