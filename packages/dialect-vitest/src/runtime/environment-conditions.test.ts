// T8.7, the Vitest half. The value is checked against the recorded run by policy-truth
// (`env/conditions-vitest-jsdom`); this pins the function's own shape.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { vitestEnvironmentConditions } from './environment-conditions.ts'

test('every environment resolves as node, a DOM one included', () => {
  assert.deepEqual(vitestEnvironmentConditions({ name: 'jsdom' }), ['node'])
  assert.deepEqual(vitestEnvironmentConditions({ name: 'happy-dom' }), ['node'])
  assert.deepEqual(vitestEnvironmentConditions({ name: 'node' }), ['node'])
})

test("an environment's own list wins", () => {
  assert.deepEqual(vitestEnvironmentConditions({ name: 'jsdom', conditions: ['worker'] }), [
    'worker',
  ])
})
