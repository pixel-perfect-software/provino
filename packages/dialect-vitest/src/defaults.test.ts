// T11.2: the dialect's values against vitest/config 5.0.5's `configDefaults` and
// `coverageConfigDefaults`, read in-process, so a version bump that changes a default fails here
// (T1.7's `policy/defaults` fixture records them from inside a real run). The defaults that follow
// the environment (`allowOnly`, `watch`, `open`, `reporters`: CI, a TTY, an agent) are not
// compared. And Track 11's module-boundaries table, row by row.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolvePolicy } from '@provino/policy'
import { configDefaults, coverageConfigDefaults } from 'vitest/config'
import { vitestPolicy } from './dialect.ts'

const policy = resolvePolicy(vitestPolicy)

test('the values vitest/config 5.0.5 has a default for are its defaults', () => {
  const defaults = configDefaults as unknown as Record<string, unknown>
  assert.equal(policy.core.maxConcurrency, configDefaults.maxConcurrency)
  assert.equal(policy.core.injectGlobals, configDefaults.globals)
  assert.equal(policy.core.eachTitleTruncate, defaults.taskTitleValueFormatTruncate)
  assert.equal(policy.mock.between.clear, configDefaults.clearMocks)
  assert.equal(policy.mock.between.reset, configDefaults.mockReset)
  assert.equal(policy.mock.between.restore, configDefaults.restoreMocks)
  assert.equal(policy.mock.between.unstubEnvs, configDefaults.unstubEnvs)
  assert.equal(policy.mock.between.unstubGlobals, configDefaults.unstubGlobals)
  assert.equal(policy.module.injectCjsGlobals, defaults.injectCjsGlobals)
  assert.equal(policy.timers.loopLimit, configDefaults.fakeTimers.loopLimit)
  assert.deepEqual(policy.orchestrator.include, configDefaults.include)
  assert.deepEqual(policy.orchestrator.exclude, configDefaults.exclude)
  assert.equal(policy.orchestrator.slowTestThresholdMs, configDefaults.slowTestThreshold)
  assert.equal(policy.orchestrator.envDefault, configDefaults.environment)
  assert.equal(policy.orchestrator.coverageProvider, coverageConfigDefaults.provider)
  assert.deepEqual(policy.orchestrator.coverageReporters, coverageConfigDefaults.reporter)
  assert.equal(policy.coverage.reportsDirectory, coverageConfigDefaults.reportsDirectory)
})

/**
 * Track 11's "Policy keys adapters supply" table (L509-L522), Vitest's column, as the keys that hold
 * each value now. `teardownTimeoutMs` (10000) is Vitest's global teardown there; Provino's
 * `timeouts.teardown` bounds a hook's returned cleanup, which `policy/core-timeouts` recorded at
 * the hook timeout, also 10000.
 */
test('Track 11`s module-boundaries rows are the dialect`s values', () => {
  const rows: readonly (readonly [string, unknown, unknown])[] = [
    ['hookOrder', policy.core.hookOrder.afterEach, 'reverse'],
    ['testTimeoutMs', policy.core.timeouts.test, 5000],
    ['hookTimeoutMs', policy.core.timeouts.hook, 10000],
    ['teardownTimeoutMs', policy.core.timeouts.teardown, configDefaults.teardownTimeout],
    ['doneCallback', policy.core.firstArg, 'context'],
    ['clearMocksDefault', policy.mock.between.clear, true],
    ['mockReset', policy.mock.resetTo, 'original-impl'],
    ['moduleFactoryResult', policy.module.factoryShape, 'namespace'],
    ['rootMocksDir', policy.module.rootMocksAutoApply, false],
    ['testNameJoin', policy.core.nameSeparator, ' > '],
    ['bailCheckAfter', policy.orchestrator.bail.checkAfter, 'test'],
    [
      'snapshotHeader',
      policy.snapshot.header,
      '// Vitest Snapshot v1, https://vitest.dev/guide/snapshot.html',
    ],
    ['injectGlobals', policy.core.injectGlobals, false],
    ['resultStatusSkipped', policy.report.resultStatusSkipped, 'skipped'],
    [
      'environmentPragma',
      policy.orchestrator.environmentPragmas,
      ['vitest-environment', 'jest-environment'],
    ],
    ['defaultInclude', policy.orchestrator.include, ['**/*.{test,spec}.?(c|m)[jt]s?(x)']],
  ]
  for (const [row, actual, expected] of rows) assert.deepEqual(actual, expected, row)
})
