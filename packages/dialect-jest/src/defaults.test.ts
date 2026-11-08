// T11.2: the dialect's values against jest-config 30.5.2's own `defaults`, read in-process, so a
// version bump that changes a default fails here (T1.7's `policy/defaults` fixture records the
// normalized ones from inside a real run). And Track 11's module-boundaries table, row by row,
// mapped to the keys that hold those values now.
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { resolvePolicy } from '@provino/policy'
import { defaults } from 'jest-config'
import { jestPolicy } from './dialect.ts'

const policy = resolvePolicy(jestPolicy)

test('the values jest-config 30.5.2 has a default for are its defaults', () => {
  assert.equal(policy.core.injectGlobals, defaults.injectGlobals)
  assert.equal(policy.core.maxConcurrency, defaults.maxConcurrency)
  assert.equal(policy.mock.between.clear, defaults.clearMocks)
  assert.equal(policy.mock.between.reset, defaults.resetMocks)
  assert.equal(policy.mock.between.restore, defaults.restoreMocks)
  assert.equal(policy.module.automock, defaults.automock)
  assert.equal(policy.module.resetModulesBetween, defaults.resetModules)
  assert.equal(policy.timers.enableGlobally, defaults.fakeTimers?.enableGlobally)
  assert.equal(policy.snapshot.format.escapeString, defaults.snapshotFormat?.escapeString)
  assert.equal(
    policy.snapshot.format.printBasicPrototype,
    defaults.snapshotFormat?.printBasicPrototype,
  )
  assert.deepEqual(policy.snapshot.serializers, defaults.snapshotSerializers)
  assert.deepEqual(policy.orchestrator.include, defaults.testMatch)
  // `testPathIgnorePatterns` are regular expressions on the path; the policy holds the glob.
  assert.deepEqual(defaults.testPathIgnorePatterns, ['/node_modules/'])
  assert.deepEqual(policy.orchestrator.exclude, ['**/node_modules/**'])
  assert.equal(policy.orchestrator.watchDefault, defaults.watch === false ? 'never' : 'tty-not-ci')
  assert.equal(policy.orchestrator.passWithNoTests, defaults.passWithNoTests)
  assert.equal(policy.orchestrator.exitCodes.failure, defaults.testFailureExitCode)
  // `babel` is babel-plugin-istanbul.
  assert.equal(defaults.coverageProvider, 'babel')
  assert.equal(policy.orchestrator.coverageProvider, 'istanbul')
  assert.deepEqual(policy.orchestrator.coverageReporters, defaults.coverageReporters)
  // Seconds there, milliseconds here.
  assert.equal(policy.orchestrator.slowTestThresholdMs, (defaults.slowTestThreshold ?? 0) * 1000)
  assert.equal(
    policy.orchestrator.envDefault,
    path.basename(String(defaults.testEnvironment)).replace(/^jest-environment-/, ''),
  )
  assert.equal(
    policy.orchestrator.pool.default,
    defaults.workerThreads === true ? 'threads' : 'forks',
  )
})

/**
 * Track 11's "Policy keys adapters supply" table (L509-L522), Jest's column, as the keys that hold
 * each value now (build-plan §6's renames, B03's slices). `n.a.` and config-only rows are said.
 */
test('Track 11`s module-boundaries rows are the dialect`s values', () => {
  const rows: readonly (readonly [string, unknown, unknown])[] = [
    ['hookOrder', policy.core.hookOrder.afterEach, 'declaration'],
    ['testTimeoutMs', policy.core.timeouts.test, 5000],
    ['hookTimeoutMs', policy.core.timeouts.hook, 5000],
    // `teardownTimeoutMs` is n.a. for Jest: it returns no cleanups, and the value bounds Provino's.
    ['doneCallback', policy.core.firstArg, 'done-if-arity'],
    ['clearMocksDefault', policy.mock.between.clear, false],
    ['mockReset', policy.mock.resetTo, 'empty'],
    ['moduleFactoryResult', policy.module.factoryShape, 'module-value'],
    ['rootMocksDir', policy.module.rootMocksAutoApply, true],
    ['testNameJoin', policy.core.nameSeparator, ' '],
    ['bailCheckAfter', policy.orchestrator.bail.checkAfter, 'file'],
    [
      'snapshotHeader',
      policy.snapshot.header,
      '// Jest Snapshot v1, https://jestjs.io/docs/snapshot-testing',
    ],
    ['injectGlobals', policy.core.injectGlobals, true],
    ['resultStatusSkipped', policy.report.resultStatusSkipped, 'pending'],
    ['environmentPragma', policy.orchestrator.environmentPragmas, ['jest-environment']],
    ['defaultInclude', policy.orchestrator.include, defaults.testMatch],
  ]
  for (const [row, actual, expected] of rows) assert.deepEqual(actual, expected, row)
})
