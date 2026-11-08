// vitest/config 5.0.5's defaults, read inside the run.
import { configDefaults, coverageConfigDefaults } from 'vitest/config'

test('vitest/config 5.0.5 defaults', async () => {
  const defaults = configDefaults as unknown as Record<string, unknown>
  await observe('core.maxConcurrency', () => configDefaults.maxConcurrency)
  await observe('core.injectGlobals', () => configDefaults.globals)
  // `taskTitleValueFormatTruncate`: how long an interpolated .each value may be.
  await observe('core.eachTitleTruncate', () => defaults.taskTitleValueFormatTruncate)
  await observe(
    'core.timeouts.teardownTimeout (global teardown)',
    () => configDefaults.teardownTimeout,
  )
  await observe('mock.between.clear', () => configDefaults.clearMocks)
  await observe('mock.between.reset', () => configDefaults.mockReset)
  await observe('mock.between.restore', () => configDefaults.restoreMocks)
  await observe('mock.between.unstubEnvs', () => configDefaults.unstubEnvs)
  await observe('mock.between.unstubGlobals', () => configDefaults.unstubGlobals)
  await observe('module.injectCjsGlobals', () => defaults.injectCjsGlobals)
  await observe('timers.loopLimit', () => configDefaults.fakeTimers.loopLimit)
  // No `snapshotSerializers` and no `expandSnapshotDiff` in the defaults: none, and off.
  await observe('snapshot.serializers', () => defaults.snapshotSerializers ?? [])
  await observe('expect.expand', () => defaults.expandSnapshotDiff ?? false)
  await observe('orchestrator.include', () => configDefaults.include)
  await observe('orchestrator.exclude', () => configDefaults.exclude)
  await observe('orchestrator.coverageProvider', () => coverageConfigDefaults.provider)
  await observe('orchestrator.coverageReporters', () => coverageConfigDefaults.reporter)
  await observe('orchestrator.slowTestThresholdMs', () => configDefaults.slowTestThreshold)
  await observe('orchestrator.envDefault', () => configDefaults.environment)
  await observe('report.defaultReporters', () => configDefaults.reporters)
  await observe('coverage.reportsDirectory', () => coverageConfigDefaults.reportsDirectory)
})
