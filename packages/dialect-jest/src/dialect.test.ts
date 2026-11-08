import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
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
import { jestMockPolicy } from './mock-policy.ts'

const resolved = resolvePolicy(jestPolicy)

test('the dialect is Jest 30.5, with the policy this package exports', () => {
  assert.equal(jestDialect.name, 'jest')
  assert.equal(jestDialect.version, '30.5')
  assert.equal(jestDialect.policy, jestPolicy)
  assert.equal(jestPolicy.expect, jestExpectPolicy)
  assert.equal(jestPolicy.mock, jestMockPolicy)
})

// `pretty-format` is the one formatter `ExpectPolicy.valueFormatter` allows, so T1.7 claims the
// value as Provino's own, pinned here.
test('the value formatter is pretty-format, the one the type allows', () => {
  assert.equal(resolved.expect.valueFormatter, 'pretty-format')
})

test('the mock slice is whole, so no `mock.*` key is left at the neutral value', () => {
  assert.deepEqual(Object.keys(jestMockPolicy).sort(), Object.keys(neutralPolicy.mock).sort())
  assert.deepEqual(
    Object.keys(jestMockPolicy.between).sort(),
    Object.keys(neutralPolicy.mock.between).sort(),
  )
  assert.equal(resolved.mock.newCall, 'apply')
  assert.deepEqual(resolved.mock.messages, jestMockPolicy.messages)
})

test('the mock messages are jest-mock`s, with the two placeholders the engine fills', () => {
  const messages = jestMockPolicy.messages
  assert.equal(messages['spy-primitive'], 'Cannot use spyOn on a primitive value; {type} given')
  assert.equal(
    messages['spy-not-a-function-primitive'],
    "Cannot spy on the `{key}` property because it is not a function; {type} given instead. If you are trying to mock a property, use `jest.replaceProperty(object, '{key}', value)` instead.",
  )
  for (const code of [
    'spy-no-key',
    'spy-missing',
    'spy-not-a-function',
    'spy-not-configurable',
    'spy-no-access-type',
    'replace-primitive',
    'replace-no-key',
    'replace-missing',
    'replace-not-configurable',
    'replace-getter',
    'replace-setter',
    'replace-function',
  ]) {
    assert.equal(typeof messages[code], 'string', code)
  }
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

test('the module slice: a missing export reads undefined, and the registry texts are Jest`s', () => {
  assert.equal(resolved.module.missingFactoryExport, 'undefined')
  assert.equal(
    resolved.module.mockValueOwner,
    'module-registry',
    'mod-reregister: Jest keeps the value',
  )
  assert.equal(neutralPolicy.module.mockValueOwner, 'registration')
  assert.deepEqual(resolved.module.messages, {
    'module-missing':
      "Cannot find module '{specifier}' from '{from}'\n\nTo mock a module that does not exist on disk, pass `{virtual: true}` in the mock options. See https://jestjs.io/docs/jest-object#jestmockmodulename-factory-options",
    'unmock-module-missing': "Cannot find module '{specifier}' from '{from}'",
    'automock-no-metadata':
      'Failed to get mock metadata: {id}\n\nSee: https://jestjs.io/docs/manual-mocks#content',
    'nested-isolation': '{caller} cannot be nested inside another {caller} or {other}.',
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

test('every behaviour ref is absolute, so a worker imports it as it is (D21)', () => {
  const refs: Array<readonly [path: string, module: string]> = []
  const collect = (value: unknown, path: string): void => {
    if (isModuleRef(value)) refs.push([path, value.module])
    else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) collect(child, `${path}.${key}`)
    }
  }
  collect(serializePolicy(resolved), 'policy')
  assert.ok(jestDialect.globals !== undefined)
  refs.push(['globals', jestDialect.globals.factory.module])
  // The matcher table, the three the neutral policy supplies, and the globals factory.
  assert.ok(refs.length >= 5, refs.map(([path]) => path).join(', '))
  for (const [path, module] of refs) {
    assert.ok(isAbsolute(module) || module.startsWith('file:'), `${path} is ${module}`)
  }
})

/** The leaf values of a policy: the paths a layer can set (`mock.messages`, `module.messages` and `byEnvironment` are open records). */
function leafPaths(value: unknown, path = ''): string[] {
  const leaf =
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    value instanceof RegExp ||
    isModuleRef(value) ||
    path === 'mock.messages' ||
    path === 'module.messages' ||
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
      'timers.fakeTemporal',
      'timers.facadeReturns',
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
