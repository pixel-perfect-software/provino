import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  diffPolicy,
  isModuleRef,
  neutralPolicy,
  resolvePolicy,
  serializePolicy,
} from '@provino/policy'
import type { Policy } from '@provino/types'
import { jestDialect, jestPolicy } from './dialect.ts'
import { jestExpectPolicy } from './expect-policy.ts'

const resolved = resolvePolicy(jestPolicy)

test('the dialect is Jest 30.5, with the policy this package exports', () => {
  assert.equal(jestDialect.name, 'jest')
  assert.equal(jestDialect.version, '30.5')
  assert.equal(jestDialect.policy, jestPolicy)
  assert.equal(jestPolicy.expect, jestExpectPolicy)
})

test('the divergences from the neutral policy are Jest`s', () => {
  const rows = diffPolicy(neutralPolicy, resolved)
  const row = (path: string) => rows.find((candidate) => candidate.path === path)
  assert.deepEqual(row('core.hookOrder.afterEach'), {
    path: 'core.hookOrder.afterEach',
    a: 'reverse',
    b: 'declaration',
  })
  assert.deepEqual(row('core.nameSeparator'), { path: 'core.nameSeparator', a: ' > ', b: ' ' })
  assert.deepEqual(row('core.injectGlobals'), { path: 'core.injectGlobals', a: false, b: true })
  assert.deepEqual(row('mock.resetTo'), { path: 'mock.resetTo', a: 'original-impl', b: 'empty' })
  assert.deepEqual(row('mock.between.order'), {
    path: 'mock.between.order',
    a: ['restore', 'reset', 'clear', 'unstubEnvs', 'unstubGlobals'],
    b: ['clear', 'reset', 'restore'],
  })
  assert.deepEqual(row('timers.loopLimit'), { path: 'timers.loopLimit', a: 10000, b: 100000 })
  assert.deepEqual(row('module.factoryShape'), {
    path: 'module.factoryShape',
    a: 'namespace',
    b: 'module-value',
  })
  assert.deepEqual(row('snapshot.header'), {
    path: 'snapshot.header',
    a: '// Provino Snapshot v1',
    b: '// Jest Snapshot v1, https://jestjs.io/docs/snapshot-testing',
  })
  assert.deepEqual(row('orchestrator.bail.checkAfter'), {
    path: 'orchestrator.bail.checkAfter',
    a: 'test',
    b: 'file',
  })
  assert.deepEqual(row('report.displaySeparator'), {
    path: 'report.displaySeparator',
    a: ' > ',
    b: ' › ',
  })
  assert.deepEqual(row('expect.matcherNamespace'), {
    path: 'expect.matcherNamespace',
    a: 'provino',
    b: 'jest',
  })
  assert.deepEqual(row('coverage.thresholdGrouping'), {
    path: 'coverage.thresholdGrouping',
    a: 'all-files',
    b: 'first-match',
  })
})

test('values that equal the neutral ones are not divergences', () => {
  const paths = new Set(diffPolicy(neutralPolicy, resolved).map((row) => row.path))
  for (const path of [
    'core.maxConcurrency',
    'snapshot.dirName',
    'orchestrator.unhandledErrors',
    'orchestrator.isolationDefault.default',
    'orchestrator.envDefault',
  ]) {
    assert.equal(paths.has(path), false, path)
  }
})

test('the default isolation tier is registry (DECISIONS D6), and the DOM environments stay on realm', () => {
  assert.deepEqual(resolved.orchestrator.isolationDefault, {
    default: 'registry',
    byEnvironment: { jsdom: 'realm', 'happy-dom': 'realm' },
  })
})

test('the policy serializes: every behaviour key is a module ref', () => {
  const serialized = serializePolicy(resolved)
  assert.deepEqual(structuredClone(serialized), serialized)
  const matcherTable = serialized.expect.matcherTable
  assert.ok(matcherTable !== null && isModuleRef(matcherTable))
  assert.equal(matcherTable.export, 'jestExpectTable')
  assert.ok(isModuleRef(serialized.core.formatEachTitle))
})

/** The leaf values of a policy: the paths a layer can set (`mock.messages` and `byEnvironment` are open records). */
function leafPaths(value: unknown, path = ''): string[] {
  const leaf =
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    value instanceof RegExp ||
    isModuleRef(value) ||
    path === 'mock.messages' ||
    path === 'orchestrator.isolationDefault.byEnvironment'
  if (leaf) return [path]
  return Object.entries(value).flatMap(([key, child]) =>
    leafPaths(child, path === '' ? key : `${path}.${key}`),
  )
}

test('the keys the dialect leaves to the neutral policy are the ones listed in dialect.ts', () => {
  const all = leafPaths(neutralPolicy satisfies Policy)
  const set = new Set(leafPaths(jestPolicy))
  assert.deepEqual(
    all.filter((path) => !set.has(path)).sort(),
    [
      'core.doneDeprecatedMessage',
      'core.formatEachTitle',
      'core.orderHooks',
      'mock.newCall',
      'mock.messages',
      'timers.fakeTemporal',
      'timers.notFaked',
      'timers.setSystemTimeWithoutFakes',
      'timers.facadeReturns',
      'module.missingFactoryExport',
      'snapshot.key',
      'snapshot.serializers',
      'snapshot.resolvePath',
      'orchestrator.environmentConditions',
      'orchestrator.isolationDefault.byEnvironment',
    ].sort(),
  )
  assert.deepEqual(
    [...set].filter((path) => !all.includes(path)),
    [],
    'the dialect sets no key the policy does not have',
  )
})
