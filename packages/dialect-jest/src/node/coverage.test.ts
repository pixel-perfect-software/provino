// `jestCoverageOptions` (B23b, T8.10): what the coordinator reports with, read from Jest's global
// config as CoverageReporter reads it. The reports themselves are held to Jest 30.5.2's by
// `provino`'s `jest-coverage.test.ts`; here, the rules no recording can show apart.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { jestCoverageFilter, jestCoverageOptions, jestCoverageTexts } from './coverage.ts'
import type { JestGlobalConfig, JestProjectConfig } from './types.ts'

/** The global config keys `jestCoverageOptions` reads; the rest never matter to it. */
function globalConfig(overrides: Partial<JestGlobalConfig> = {}): JestGlobalConfig {
  return {
    coverageProvider: 'babel',
    coverageReporters: ['json', 'text', 'lcov', 'clover'],
    coverageDirectory: '/project/coverage',
    coverageThreshold: undefined,
    useStderr: false,
    ...overrides,
  } as JestGlobalConfig
}

const NO_TERMINAL = { env: {}, stdoutColumns: undefined }

test('the reporters keep their order, each with maxCols under its own options', () => {
  const options = jestCoverageOptions(
    globalConfig({ coverageReporters: ['text', ['lcov', { projectRoot: '..' }]] }),
    NO_TERMINAL,
  )
  assert.equal(options.provider, 'istanbul')
  assert.equal(options.directory, '/project/coverage')
  assert.deepEqual(options.reporters, [
    ['text', { maxCols: Number.POSITIVE_INFINITY }],
    ['lcov', { maxCols: Number.POSITIVE_INFINITY, projectRoot: '..' }],
  ])
  // A reporter's own maxCols wins (`{ maxCols: getMaxCols(), ...additionalOptions }`).
  const own = jestCoverageOptions(
    globalConfig({ coverageReporters: [['text', { maxCols: 40 }]] }),
    NO_TERMINAL,
  )
  assert.deepEqual(own.reporters, [['text', { maxCols: 40 }]])
})

test('no reporters: text-summary, unless useStderr (--json) is on', () => {
  const none = globalConfig({ coverageReporters: [] })
  assert.deepEqual(jestCoverageOptions(none, NO_TERMINAL).reporters, [
    ['text-summary', { maxCols: Number.POSITIVE_INFINITY }],
  ])
  assert.deepEqual(
    jestCoverageOptions({ ...none, useStderr: true } as JestGlobalConfig, NO_TERMINAL).reporters,
    [],
  )
})

test("getMaxCols: the terminal's width, then COLUMNS, then 80 in CI outside a worker, else none", () => {
  const cols = (env: Readonly<Record<string, string>>, stdoutColumns?: number): unknown =>
    jestCoverageOptions(globalConfig({ coverageReporters: ['text'] }), { env, stdoutColumns })
      .reporters[0]?.[1]
  assert.deepEqual(cols({ COLUMNS: '100', CI: 'true' }, 132), { maxCols: 132 })
  assert.deepEqual(cols({ COLUMNS: '100', CI: 'true' }), { maxCols: 100 })
  assert.deepEqual(cols({ CI: 'true' }), { maxCols: 80 })
  assert.deepEqual(cols({ GITHUB_ACTIONS: 'true' }), { maxCols: 80 })
  assert.deepEqual(cols({ CI: 'true', JEST_WORKER_ID: '1' }), {
    maxCols: Number.POSITIVE_INFINITY,
  })
  // `CI=1` is not `'true'`: the recorder's environment has no limit.
  assert.deepEqual(cols({ CI: '1' }), { maxCols: Number.POSITIVE_INFINITY })
  assert.deepEqual(cols({ COLUMNS: '0' }), { maxCols: Number.POSITIVE_INFINITY })
})

test("watermarks are istanbul-lib-report's defaults, with the global thresholds as the high marks", () => {
  // The oracle: the istanbul-lib-report @jest/reporters 30.5.2 installs, reached through jest-cli.
  const fromCli = createRequire(createRequire(import.meta.url).resolve('jest-cli/package.json'))
  const fromCore = createRequire(fromCli.resolve('@jest/core/package.json'))
  const fromReporters = createRequire(fromCore.resolve('@jest/reporters/package.json'))
  const report = fromReporters('istanbul-lib-report') as { getDefaultWatermarks(): unknown }
  assert.deepEqual(jestCoverageOptions(globalConfig(), NO_TERMINAL).watermarks, {
    ...(report.getDefaultWatermarks() as object),
  })
  const raised = jestCoverageOptions(
    globalConfig({ coverageThreshold: { global: { lines: 90, branches: 70 } } }),
    NO_TERMINAL,
  )
  assert.deepEqual(raised.watermarks, {
    statements: [50, 80],
    branches: [50, 70],
    functions: [50, 80],
    lines: [50, 90],
  })
})

test('the threshold groups keep the config order and only the metrics they set', () => {
  const options = jestCoverageOptions(
    globalConfig({
      coverageThreshold: {
        './src/a.ts': { lines: 100 },
        global: { statements: -10, functions: 50 },
        '**/b/*.ts': { branches: 20, perFile: true },
      },
    }),
    NO_TERMINAL,
  )
  assert.deepEqual(options.thresholds, [
    { name: './src/a.ts', lines: 100 },
    { name: 'global', statements: -10, functions: 50 },
    { name: '**/b/*.ts', branches: 20 },
  ])
})

test("the texts around the reports are CoverageReporter's", () => {
  assert.equal(jestCoverageTexts.untestedNotice, 'Running coverage on untested files...')
  assert.equal(
    jestCoverageTexts.untestedFailure('/p/a.ts', 'boom', 'Error: boom\n    at x'),
    'Failed to collect coverage from /p/a.ts\nERROR: boom\nSTACK: Error: boom\n    at x',
  )
  assert.equal(
    jestCoverageTexts.reportFailure('Error: no', 'Error: no\n    at y'),
    '\n        Failed to write coverage reports:\n        ERROR: Error: no\n        STACK: Error: no\n    at y\n      ',
  )
})

test('under the default babel-jest the instrument root is the process cwd, else the project root', () => {
  const project = {
    rootDir: '/repo',
    cwd: '/repo/packages/a',
    forceCoverageMatch: [],
    testMatch: [],
    testRegex: [],
    testPathIgnorePatterns: [],
    coveragePathIgnorePatterns: [],
    setupFiles: [],
    setupFilesAfterEnv: [],
  } as unknown as JestProjectConfig
  const global = {
    ...globalConfig(),
    rootDir: '/repo',
    collectCoverageFrom: [],
  } as JestGlobalConfig
  const babel = { babelInstruments: true }
  assert.equal(jestCoverageFilter(project, global, babel).instrumentRoot, '/repo/packages/a')
  assert.equal('instrumentRoot' in jestCoverageFilter(project, global), false)
  const atRoot = { ...project, cwd: '/repo' } as JestProjectConfig
  assert.equal('instrumentRoot' in jestCoverageFilter(atRoot, global, babel), false)
})
