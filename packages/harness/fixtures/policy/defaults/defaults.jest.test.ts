// jest-config 30.5.2's own normalization of an empty config, read inside the run.
type Options = Record<string, unknown>
const path = process.getBuiltinModule('node:path')
const { readConfig } = require('jest-config') as {
  readConfig: (
    argv: Options,
    config: Options,
    skipArgvConfigOption: boolean,
    parentConfigDirname: string,
  ) => Promise<{ globalConfig: Options; projectConfig: Options }>
}

test('jest-config 30.5.2 defaults, normalized', async () => {
  const root = process.cwd()
  // An inline config needs the directory it stands for (jest-config `readConfig`).
  const { globalConfig, projectConfig } = await readConfig(
    { $0: 'jest', _: [] },
    { rootDir: root },
    false,
    root,
  )
  const format = projectConfig.snapshotFormat as Options
  const fakeTimers = projectConfig.fakeTimers as Options
  const relative = (value: unknown): string => path.relative(root, String(value))

  await observe('core.maxConcurrency', () => globalConfig.maxConcurrency)
  await observe('core.injectGlobals', () => projectConfig.injectGlobals)
  await observe('mock.between.clear', () => projectConfig.clearMocks)
  await observe('mock.between.reset', () => projectConfig.resetMocks)
  await observe('mock.between.restore', () => projectConfig.restoreMocks)
  await observe('module.automock', () => projectConfig.automock)
  await observe('module.resetModulesBetween', () => projectConfig.resetModules)
  await observe('timers.enableGlobally', () => fakeTimers.enableGlobally)
  await observe('snapshot.format.escapeString', () => format.escapeString)
  await observe('snapshot.format.printBasicPrototype', () => format.printBasicPrototype)
  // No `maxOutputLength` key: unlimited.
  await observe('snapshot.format.maxOutputLength', () => format.maxOutputLength ?? null)
  await observe('expect.expand', () => globalConfig.expand)
  await observe('orchestrator.include', () => projectConfig.testMatch)
  // `testPathIgnorePatterns` are regular expressions on the path; the policy holds globs, and
  // `/node_modules/` is the glob `**/node_modules/**`.
  await observe('orchestrator.exclude', () =>
    (projectConfig.testPathIgnorePatterns as string[]).map((pattern) =>
      pattern === '/node_modules/' ? '**/node_modules/**' : pattern,
    ),
  )
  // `watch: false` and `watchAll: false`: Jest watches only when asked.
  await observe('orchestrator.watchDefault', () =>
    globalConfig.watch === false && globalConfig.watchAll === false ? 'never' : 'tty-not-ci',
  )
  await observe('orchestrator.passWithNoTests', () => globalConfig.passWithNoTests)
  await observe('orchestrator.exitCodes.failure', () => globalConfig.testFailureExitCode)
  // `babel` is babel-plugin-istanbul: the policy calls it `istanbul`.
  await observe('orchestrator.coverageProvider', () =>
    globalConfig.coverageProvider === 'babel' ? 'istanbul' : globalConfig.coverageProvider,
  )
  await observe('orchestrator.coverageReporters', () => globalConfig.coverageReporters)
  // In seconds; the policy holds milliseconds.
  await observe(
    'orchestrator.slowTestThresholdMs',
    () => Number(projectConfig.slowTestThreshold) * 1000,
  )
  // A path to jest-environment-node; the policy names the environment.
  await observe('orchestrator.envDefault', () =>
    path
      .basename(path.dirname(path.dirname(String(projectConfig.testEnvironment))))
      .replace(/^jest-environment-/, ''),
  )
  await observe('orchestrator.pool.default', () =>
    globalConfig.workerThreads === true ? 'threads' : 'forks',
  )
  // No `reporters`: Jest uses its default reporter.
  await observe('report.defaultReporters', () => globalConfig.reporters ?? ['default'])
  await observe('coverage.reportsDirectory', () => relative(globalConfig.coverageDirectory))
})
