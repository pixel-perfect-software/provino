import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createBehaviourLoader,
  diffPolicy,
  forEachModuleRef,
  neutralPolicy,
  resolvePolicy,
  serializePolicy,
} from '@provino/policy'
import type { GlobalsFactory, GlobalsHost } from '@provino/types'
import { vitestDialect, vitestPolicy } from './dialect.ts'
import { vitestHoistPolicy } from './hoist-policy.ts'
import { vitestMockPolicy, vitestModulePolicy } from './mock-policy.ts'

const resolved = resolvePolicy(vitestPolicy)

test('the dialect is Vitest 5.0, with the policy, hoisting and type entries this package exports', () => {
  assert.equal(vitestDialect.name, 'vitest')
  assert.equal(vitestDialect.version, '5.0')
  assert.equal(vitestDialect.policy, vitestPolicy)
  assert.equal(vitestPolicy.mock, vitestMockPolicy)
  assert.equal(vitestPolicy.module, vitestModulePolicy)
  assert.equal(vitestDialect.loader?.hoist, vitestHoistPolicy)
  assert.deepEqual(vitestDialect.typeEntries, ['@provino/dialect-vitest/runtime'])
})

test('the mock and module slices are whole, so none of their keys is left at the neutral value', () => {
  assert.deepEqual(Object.keys(vitestMockPolicy).sort(), Object.keys(neutralPolicy.mock).sort())
  assert.deepEqual(Object.keys(vitestModulePolicy).sort(), Object.keys(neutralPolicy.module).sort())
})

test('a few divergences from the neutral policy are Vitest`s', () => {
  const rows = diffPolicy(neutralPolicy, resolved)
  const row = (path: string) => rows.find((candidate) => candidate.path === path)
  assert.equal(row('core.hookOrder.afterEach'), undefined)
  assert.deepEqual(row('core.asyncDescribe'), {
    path: 'core.asyncDescribe',
    a: 'throw',
    b: 'await',
  })
  assert.deepEqual(row('core.eachTitleTruncate'), {
    path: 'core.eachTitleTruncate',
    a: null,
    b: 40,
  })
  assert.deepEqual(row('mock.between.restore'), { path: 'mock.between.restore', a: true, b: false })
  assert.deepEqual(row('snapshot.header'), {
    path: 'snapshot.header',
    a: '// Provino Snapshot v1',
    b: '// Vitest Snapshot v1, https://vitest.dev/guide/snapshot.html',
  })
})

test('the resolved policy serializes, and every ref in it is absolute (D21)', () => {
  const serialized = serializePolicy(resolved)
  assert.doesNotThrow(() => structuredClone(serialized))
  let refs = 0
  forEachModuleRef(resolved, '', (ref) => {
    refs += 1
    assert.ok(ref.module.startsWith('file:') || isAbsolute(ref.module), ref.module)
  })
  assert.ok(refs > 0)
})

test('the globals factory is an absolute ref to a stub that throws VITEST_DIALECT_NOT_BUILT', async () => {
  const globals = vitestDialect.globals
  assert.ok(globals !== undefined)
  assert.ok(isAbsolute(fileURLToPath(globals.factory.module)))
  const factory: GlobalsFactory = await createBehaviourLoader().load(globals.factory)
  assert.throws(
    () => factory({} as GlobalsHost),
    (error: unknown) =>
      error instanceof Error && (error as { code?: unknown }).code === 'VITEST_DIALECT_NOT_BUILT',
  )
  assert.equal(globals.names.length, 19)
  assert.deepEqual(globals.names, [...globals.names].sort())
})
