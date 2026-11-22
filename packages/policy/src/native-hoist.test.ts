import assert from 'node:assert/strict'
import { test } from 'provino'
import { NATIVE_HOISTED_CALLS, nativeHoistPolicy } from './native-hoist.ts'

// Provino's own values (no ground truth applies). What the hoister does under them is held by
// `provino`'s `native-hoist.test.ts` (the hoister with `NATIVE_RUNTIME.hoist`) and, end to end,
// `native-mocks.test.ts`.
test('every hoisted call is both recognised and ruled, from one list', () => {
  const policy = nativeHoistPolicy('provino')
  assert.deepEqual(Object.keys(policy.hoistCalls), [...NATIVE_HOISTED_CALLS])
  assert.deepEqual(
    policy.importedCalls?.map((call) => call.exportName),
    [...NATIVE_HOISTED_CALLS],
  )
})

test('the served module is the one given, and its import stays static', () => {
  const policy = nativeHoistPolicy('served')
  assert.deepEqual(new Set(policy.importedCalls?.map((call) => call.module)), new Set(['served']))
  assert.deepEqual(policy.runnerModules, ['served'])
  // The module is part of the id, so two served names never share a transform cache entry.
  assert.notEqual(policy.id, nativeHoistPolicy('provino').id)
})

test('the policy clones (it crosses to a worker by value)', () => {
  const policy = nativeHoistPolicy('provino')
  assert.deepEqual(structuredClone(policy), policy)
})
