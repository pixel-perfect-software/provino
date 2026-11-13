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

// The values that are Provino's own (T1.7 claims them as `own`): isolation is D6's tier for Jest,
// taken for Vitest too (it isolates each file's module graph, as `registry` does); the hoisting
// rules' `id` only names them for the transform cache; `pretty-format` is the one formatter the
// type allows.
test('the values that are Provino`s own: the isolation tier, the hoisting id, the formatter', () => {
  assert.deepEqual(resolved.orchestrator.isolationDefault, {
    default: 'registry',
    byEnvironment: { jsdom: 'realm', 'happy-dom': 'realm' },
  })
  assert.equal(vitestHoistPolicy.id, 'vitest-5.0')
  assert.equal(resolved.expect.valueFormatter, 'pretty-format')
})

test('core.formatValue is the neutral printer: Vitest has no done and ignores a returned value', () => {
  assert.deepEqual(resolved.core.formatValue, neutralPolicy.core.formatValue)
  assert.equal(resolved.core.firstArg, 'context')
  assert.equal(resolved.core.nonPromiseReturn, 'ignore')
})

test('the context a test receives is a function that throws done`s deprecation', () => {
  assert.equal(
    resolved.core.doneDeprecatedMessage,
    'done() callback is deprecated, use promise instead',
  )
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
  // D7: Vitest 5.0.5 never calls a function `retry.condition` and retries every failure; the
  // dialect keeps that outcome and warns, where neutral calls the function.
  assert.deepEqual(row('core.retry.functionCondition'), {
    path: 'core.retry.functionCondition',
    a: 'call',
    b: 'ignore-warn',
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

test('mapperMiss is null: Vitest has no moduleNameMapper, so a miss is a not-found', () => {
  assert.equal(vitestModulePolicy.mapperMiss, null)
})
