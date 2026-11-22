import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nativeHoistPolicy } from './native-hoist.ts'

// Provino's own values (no ground truth applies), pinned: a change here changes what every native
// test file hoists. The hoister's behaviour under it is `@provino/transform`'s
// `imported-call.test.ts`; end to end, `provino`'s `native-mocks.test.ts`.
test('the native hoist policy recognises mock and unmock imported from provino', () => {
  assert.deepEqual(nativeHoistPolicy.objects, [
    { kind: 'imported-call', module: 'provino', exportName: 'mock' },
    { kind: 'imported-call', module: 'provino', exportName: 'unmock' },
  ])
  assert.deepEqual(nativeHoistPolicy.hoistCalls, { mock: 'any', unmock: 'any' })
  assert.deepEqual(nativeHoistPolicy.runnerModules, ['provino'])
})

test('the native hoist policy pins its placement and rewrite choices', () => {
  assert.equal(nativeHoistPolicy.id, 'provino-native-1')
  assert.equal(nativeHoistPolicy.placement, 'top-level-only')
  assert.equal(nativeHoistPolicy.reExports, 'in-order')
  assert.equal(nativeHoistPolicy.rewrittenCalls, 'detached')
  assert.equal(nativeHoistPolicy.factoryReferences, 'allow')
  assert.equal(nativeHoistPolicy.chainable, false)
  assert.deepEqual(nativeHoistPolicy.hoistValues, [])
  assert.deepEqual(nativeHoistPolicy.rewriteImportArg, [])
  assert.deepEqual(nativeHoistPolicy.topLevelGuards, [])
})

test('the native hoist policy is frozen and clones (it crosses to a worker by value)', () => {
  assert.ok(Object.isFrozen(nativeHoistPolicy))
  assert.ok(Object.isFrozen(nativeHoistPolicy.objects))
  assert.ok(Object.isFrozen(nativeHoistPolicy.messages))
  assert.deepEqual(structuredClone(nativeHoistPolicy), nativeHoistPolicy)
})

test('the native hoist policy words every violation, naming the call', () => {
  for (const [code, text] of Object.entries(nativeHoistPolicy.messages)) {
    assert.match(text, /\{call\}/, code)
  }
})
