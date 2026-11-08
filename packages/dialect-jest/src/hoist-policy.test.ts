import assert from 'node:assert/strict'
import { test } from 'node:test'
import { jestHoistPolicy } from './hoist-policy.ts'

test('the policy names the plugin it mirrors and the rules of its FUNCTIONS table', () => {
  assert.equal(jestHoistPolicy.id, 'jest-30.5')
  assert.deepEqual(jestHoistPolicy.hoistCalls, {
    mock: 'path-factory-options',
    unmock: 'one-string',
    deepUnmock: 'one-string',
    enableAutomock: 'no-args',
    disableAutomock: 'no-args',
  })
  assert.ok(!('doMock' in jestHoistPolicy.hoistCalls), 'doMock never hoists')
  assert.ok(!('dontMock' in jestHoistPolicy.hoistCalls), 'dontMock never hoists')
  assert.deepEqual(jestHoistPolicy.hoistValues, [])
  assert.deepEqual(jestHoistPolicy.rewriteImportArg, [])
  assert.equal(jestHoistPolicy.chainable, true)
  assert.equal(jestHoistPolicy.placement, 'enclosing-block')
  assert.deepEqual(jestHoistPolicy.runnerModules, ['@jest/globals'])
})

test('the mock object is the global jest, the imported jest and a namespace import member', () => {
  assert.deepEqual(jestHoistPolicy.objects, [
    { kind: 'global', name: 'jest' },
    { kind: 'import', module: '@jest/globals', exportName: 'jest' },
    { kind: 'namespace-member', module: '@jest/globals', exportName: 'jest' },
  ])
})

test('the factory rule allows mock-prefixed names in any case and coverage names in one', () => {
  const rule = jestHoistPolicy.factoryReferences
  assert.notEqual(rule, 'allow')
  if (rule === 'allow') return
  assert.equal(rule.hoistPureConsts, true)
  for (const name of ['mockFn', 'MOCK_FN', 'MockFn', 'cov_1abc', '__cov_x']) {
    assert.ok(rule.allowPattern.test(name), name)
  }
  for (const name of ['Cov_1', 'notmock', 'mocha']) {
    assert.equal(rule.allowPattern.test(name), false, name)
  }
})

test('the allow list follows the running Node, as the plugin computes it when it loads', async () => {
  const name = '__provino_new_global__'
  Reflect.set(globalThis, name, 1)
  try {
    // A second instance of the module, so it loads with the extra global in place.
    const fresh: typeof import('./hoist-policy.ts') = await import(
      new URL('./hoist-policy.ts?with-a-new-global', import.meta.url).href
    )
    const rule = fresh.jestHoistPolicy.factoryReferences
    assert.notEqual(rule, 'allow')
    if (rule === 'allow') return
    assert.ok(rule.allowGlobals.has(name), 'a global the running Node has')
    assert.match(fresh.jestHoistPolicy.messages.HOIST_FACTORY_OUT_OF_SCOPE, new RegExp(name))
    for (const fixed of ['Generator', 'InternalError', 'jest', 'expect', 'require', '__dirname']) {
      assert.ok(rule.allowGlobals.has(fixed), `the plugin's own ${fixed}`)
    }
  } finally {
    Reflect.deleteProperty(globalThis, name)
  }
})

test('the allow list is sorted as the plugin sorts it, with the plugin own names', () => {
  const rule = jestHoistPolicy.factoryReferences
  assert.notEqual(rule, 'allow')
  if (rule === 'allow') return
  const names = [...rule.allowGlobals]
  assert.deepEqual(names, names.toSorted(), 'sorted by UTF-16 code unit, as Array#sort does')
  assert.equal(new Set(names).size, names.length)
  for (const name of [
    'Array',
    'Promise',
    'jest',
    'expect',
    'require',
    'module',
    'process',
    'undefined',
  ]) {
    assert.ok(rule.allowGlobals.has(name), name)
  }
  assert.ok(!rule.allowGlobals.has('describe'))
})

test('the messages are the plugin text, with the allowed list embedded', () => {
  const { messages } = jestHoistPolicy
  assert.equal(
    messages.HOIST_FACTORY_NOT_FUNCTION,
    'The second argument of `jest.mock` must be an inline function.\n',
  )
  assert.match(
    messages.HOIST_FACTORY_OUT_OF_SCOPE,
    /^The module factory of `jest\.mock\(\)` is not allowed to reference any out-of-scope variables\.\nInvalid variable access: \{name\}\nAllowed objects: AbortController, AbortSignal, .*, unescape\.\nNote: This is a precaution to guard against uninitialized mock variables\. If it is ensured that the mock is required lazily, variable names prefixed with `mock` \(case insensitive\) are permitted\.\n$/,
  )
})
