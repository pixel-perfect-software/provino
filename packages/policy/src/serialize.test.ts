import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { FormatEachTitle, PolicyOverrides, SnapshotKey } from '@provino/types'
import { moduleRef } from './module-ref.ts'
import { neutralPolicy } from './neutral.ts'
import { resolvePolicy } from './resolve.ts'
import { serializePolicy } from './serialize.ts'

// Two sample dialect layers that give every behaviour key a ModuleRef, as built-in dialects
// will (B14). Their values are samples, not Jest or Vitest ground truth.
const sampleA: PolicyOverrides = {
  core: {
    nameSeparator: ' ',
    formatEachTitle: moduleRef<FormatEachTitle>('file:///dialect-a/runtime.ts', 'formatEachTitle'),
  },
  snapshot: { key: moduleRef<SnapshotKey>('file:///dialect-a/runtime.ts', 'snapshotKey') },
  module: { unmockedPathPatterns: [/node_modules\/left-real/] },
}
const sampleB: PolicyOverrides = {
  core: { hookOrder: { afterEach: 'reverse', afterAll: 'reverse' } },
  orchestrator: { isolationDefault: { byEnvironment: { jsdom: 'realm' } } },
}

describe('serializePolicy', () => {
  for (const [name, layer] of [
    ['neutral', undefined],
    ['sample dialect A', sampleA],
    ['sample dialect B', sampleB],
  ] as const) {
    test(`structuredClone(serializePolicy(p)) succeeds and round-trips: ${name}`, () => {
      const serialized = serializePolicy(resolvePolicy(layer))
      assert.deepEqual(structuredClone(serialized), serialized)
    })
  }

  test('behaviour keys cross as plain { module, export } refs', () => {
    const serialized = serializePolicy(resolvePolicy(sampleA))
    assert.deepEqual(serialized.core.formatEachTitle, {
      module: 'file:///dialect-a/runtime.ts',
      export: 'formatEachTitle',
    })
    assert.deepEqual(Object.keys(serialized.snapshot.key), ['module', 'export'])
  })

  test('data keys are copied as they are', () => {
    const serialized = serializePolicy(resolvePolicy(sampleA))
    assert.equal(serialized.core.nameSeparator, ' ')
    assert.deepEqual(serialized.module.unmockedPathPatterns, [/node_modules\/left-real/])
  })

  test('a closure in a behaviour key throws POLICY_CLOSURE_NOT_SERIALIZABLE with its path', () => {
    const policy = resolvePolicy({ snapshot: { key: (name, n) => `${name} ${n}` } })
    assert.throws(() => serializePolicy(policy), {
      code: 'POLICY_CLOSURE_NOT_SERIALIZABLE',
      path: 'snapshot.key',
    })
  })

  test('why: structuredClone rejects a policy that still holds a closure', () => {
    const policy = resolvePolicy({ snapshot: { key: (name, n) => `${name} ${n}` } })
    assert.throws(() => structuredClone(policy), { name: 'DataCloneError' })
  })

  test('the neutral policy itself is clone-safe', () => {
    assert.deepEqual(structuredClone(neutralPolicy), serializePolicy(neutralPolicy))
  })
})
