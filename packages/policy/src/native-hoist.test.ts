import assert from 'node:assert/strict'
import { test } from 'provino'
import { NATIVE_CALLBACK_SCOPES, NATIVE_HOISTED_CALLS, nativeHoistPolicy } from './native-hoist.ts'

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

test('the isolation calls are callback scopes, from the served module, not hoisted calls', () => {
  const policy = nativeHoistPolicy('served')
  assert.deepEqual(
    policy.callbackScopes,
    NATIVE_CALLBACK_SCOPES.map((exportName) => ({ module: 'served', exportName })),
  )
  assert.deepEqual(NATIVE_CALLBACK_SCOPES, ['isolateModules', 'isolateModulesAsync'])
  for (const name of NATIVE_CALLBACK_SCOPES)
    assert.equal(Object.hasOwn(policy.hoistCalls, name), false)
  // The same names as bare globals, for `globals: true`.
  assert.deepEqual(policy.globalCallbackScopes, [...NATIVE_CALLBACK_SCOPES])
  // Bumped with globalCallbackScopes, so a transform cached under the old rules is not reused.
  assert.equal(policy.id, 'provino-native-3:served')
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
