import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { PolicyOverrides, SnapshotKey } from '@provino/types'
import { PolicyError } from './errors.ts'
import { moduleRef } from './module-ref.ts'
import { neutralPolicy } from './neutral.ts'
import { resolvePolicy } from './resolve.ts'

// Four layers that each set `nameSeparator`, plus one key only they set, so every result shows
// which layer won.
const dialect: PolicyOverrides = {
  core: { nameSeparator: 'dialect', hookOrder: { afterAll: 'declaration' }, maxConcurrency: 2 },
  mock: { defaultName: 'dialect.fn()' },
}
const project: PolicyOverrides = {
  core: { nameSeparator: 'project', maxConcurrency: 3 },
  timers: { loopLimit: 7 },
}
const facade: PolicyOverrides = {
  core: { nameSeparator: 'facade' },
  mock: { resetTo: 'empty' },
}

describe('resolvePolicy precedence: neutral ← dialect ← project ← facade', () => {
  test('with no layers, it is the neutral policy', () => {
    assert.deepEqual(resolvePolicy(), neutralPolicy)
  })

  test('each layer overrides the ones below it, key by key', () => {
    const p = resolvePolicy(dialect, project, facade)
    assert.equal(p.core.nameSeparator, 'facade') // set by all four: facade wins
    assert.equal(p.core.maxConcurrency, 3) // dialect and project: project wins
    assert.equal(p.core.hookOrder.afterAll, 'declaration') // dialect only
    assert.equal(p.mock.defaultName, 'dialect.fn()') // dialect only
    assert.equal(p.timers.loopLimit, 7) // project only
    assert.equal(p.mock.resetTo, 'empty') // facade only
    assert.equal(p.core.testNamePatternFlags, neutralPolicy.core.testNamePatternFlags) // none
  })

  test('nested groups merge: siblings of an overridden key keep their value', () => {
    const p = resolvePolicy(dialect)
    assert.deepEqual(p.core.hookOrder, { ...neutralPolicy.core.hookOrder, afterAll: 'declaration' })
  })

  test('order matters: the same layers reversed give the other result', () => {
    assert.equal(resolvePolicy(facade, project, dialect).core.nameSeparator, 'dialect')
  })

  test('an undefined layer is skipped', () => {
    assert.deepEqual(resolvePolicy(undefined, project, undefined), resolvePolicy(project))
  })
})

describe('resolvePolicy merge rules', () => {
  test('arrays replace whole, never concatenate', () => {
    const p = resolvePolicy({ mock: { between: { order: ['clear'] } } })
    assert.deepEqual(p.mock.between.order, ['clear'])
    assert.equal(p.mock.between.restore, neutralPolicy.mock.between.restore)
  })

  test('a ModuleRef replaces whole, never merges with the ref below', () => {
    const ref = moduleRef<SnapshotKey>('file:///dialect/key.ts', 'key')
    const p = resolvePolicy({ snapshot: { key: ref } })
    assert.deepEqual(p.snapshot.key, ref)
  })

  test('a closure replaces a ModuleRef', () => {
    const key: SnapshotKey = (name, n) => `${name}#${n}`
    assert.equal(resolvePolicy({ snapshot: { key } }).snapshot.key, key)
  })

  test('a value can replace null and back', () => {
    const p = resolvePolicy(
      { core: { eachTitleTruncate: 40 } },
      { core: { eachTitleTruncate: null } },
    )
    assert.equal(p.core.eachTitleTruncate, null)
  })

  test('open records take new keys', () => {
    const p = resolvePolicy({
      orchestrator: { isolationDefault: { byEnvironment: { edge: 'process' } } },
      mock: { messages: { MOCK_NOT_FUNCTION: 'not a function' } },
    })
    assert.deepEqual(p.orchestrator.isolationDefault.byEnvironment, {
      ...neutralPolicy.orchestrator.isolationDefault.byEnvironment,
      edge: 'process',
    })
    assert.equal(p.mock.messages.MOCK_NOT_FUNCTION, 'not a function')
  })

  test('layers and the neutral policy are left unchanged', () => {
    const layer = { core: { nameSeparator: '/' } } as const
    const before = structuredClone(layer)
    resolvePolicy(layer)
    assert.deepEqual(layer, before)
    assert.equal(neutralPolicy.core.nameSeparator, ' > ')
  })

  test('the result is deeply frozen', () => {
    const p = resolvePolicy(project)
    assert.ok(Object.isFrozen(p))
    assert.ok(Object.isFrozen(p.core.hookOrder))
    assert.ok(Object.isFrozen(p.mock.between.order))
  })
})

describe('resolvePolicy errors', () => {
  test('an unknown key throws POLICY_UNKNOWN_KEY with its path', () => {
    const layer = JSON.parse('{"core":{"nameSeperator":"/"}}') as PolicyOverrides
    assert.throws(
      () => resolvePolicy(layer),
      (err: unknown) =>
        err instanceof PolicyError &&
        err.code === 'POLICY_UNKNOWN_KEY' &&
        err.path === 'core.nameSeperator',
    )
  })

  test('an unknown slice throws POLICY_UNKNOWN_KEY', () => {
    const layer = JSON.parse('{"reporter":{}}') as PolicyOverrides
    assert.throws(() => resolvePolicy(layer), { code: 'POLICY_UNKNOWN_KEY', path: 'reporter' })
  })

  test('a value where a group belongs throws POLICY_INVALID_LAYER', () => {
    const layer = JSON.parse('{"core":{"hookOrder":"reverse"}}') as PolicyOverrides
    assert.throws(() => resolvePolicy(layer), {
      code: 'POLICY_INVALID_LAYER',
      path: 'core.hookOrder',
    })
  })
})
