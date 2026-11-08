import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  jestConfig,
  jestMockCleanupOptions,
  OBSERVE_SETUP_PATH,
  runnerEnv,
  TRACE_ENV,
  traceSetupSource,
  vitestConfigSource,
  vitestMockCleanupOptions,
} from './runner-config.ts'

test('the Jest config runs *.test.ts except the Vitest-only files, with locations and a local cache', () => {
  const config = jestConfig(
    '/work/x',
    '/repo/src/jest-transform.ts',
    '/work/x/.harness-out/trace-setup.ts',
  )
  assert.equal(config.rootDir, '/work/x')
  assert.deepEqual(config.transform, { '\\.[cm]?ts$': '/repo/src/jest-transform.ts' })
  assert.deepEqual(config.testMatch, ['<rootDir>/**/*.test.ts'])
  assert.ok(config.testPathIgnorePatterns.includes('\\.vitest\\.test\\.ts$'))
  assert.equal(config.testLocationInResults, true)
  assert.deepEqual(config.setupFiles, ['/work/x/.harness-out/trace-setup.ts'])
  assert.equal(config.cacheDirectory, '/work/x/.jest-cache')
  assert.equal(config.watchman, false)
  const ignored = new RegExp(config.testPathIgnorePatterns[2] ?? '')
  assert.equal(ignored.test('/work/x/a.vitest.test.ts'), true)
  assert.equal(ignored.test('/work/x/a.jest.test.ts'), false)
})

test('the Vitest config is a plain-object module with globals, task locations and a local cache', () => {
  const source = vitestConfigSource('/work/x', '/work/x/.harness-out/trace-setup.ts')
  assert.match(source, /^export default \{/)
  assert.deepEqual(JSON.parse(source.replace(/^export default /, '')), {
    root: '/work/x',
    cacheDir: '/work/x/.vite',
    test: {
      globals: true,
      includeTaskLocation: true,
      include: ['**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/__goldens__/**', '**/*.jest.test.ts'],
      setupFiles: ['/work/x/.harness-out/trace-setup.ts'],
    },
  })
  assert.ok(source.endsWith('\n'))
})

test('only the vitest-list profile sets sequence.hooks, and to list', () => {
  const testOptions = (profile?: 'vitest' | 'vitest-list'): Record<string, unknown> => {
    const source = vitestConfigSource('/work/x', '/work/x/setup.ts', profile)
    return JSON.parse(source.replace(/^export default /, '')).test
  }
  assert.equal('sequence' in testOptions(), false)
  assert.equal('sequence' in testOptions('vitest'), false)
  assert.deepEqual(testOptions('vitest-list').sequence, { hooks: 'list' })
  assert.deepEqual(
    { ...testOptions('vitest-list'), sequence: undefined },
    { ...testOptions('vitest'), sequence: undefined },
  )
})

test('mockCleanup maps to Jest options: clear, reset and restore only, and only the keys given', () => {
  assert.deepEqual(jestMockCleanupOptions(undefined), {})
  assert.deepEqual(jestMockCleanupOptions({ clear: false, reset: true, restore: true }), {
    clearMocks: false,
    resetMocks: true,
    restoreMocks: true,
  })
  const config = jestConfig('/work/x', '/t.ts', '/s.ts', { mockCleanup: { reset: true } })
  assert.equal(config.resetMocks, true)
  assert.equal('clearMocks' in config, false)
  assert.equal('restoreMocks' in jestConfig('/work/x', '/t.ts', '/s.ts'), false)
})

test('mockCleanup maps to Vitest options: mockReset for reset, and the two unstubs by name', () => {
  assert.deepEqual(vitestMockCleanupOptions(undefined), {})
  assert.deepEqual(
    vitestMockCleanupOptions({
      clear: false,
      reset: true,
      restore: true,
      unstubEnvs: true,
      unstubGlobals: false,
    }),
    {
      clearMocks: false,
      mockReset: true,
      restoreMocks: true,
      unstubEnvs: true,
      unstubGlobals: false,
    },
  )
  const source = vitestConfigSource('/work/x', '/s.ts', 'vitest', {
    mockCleanup: { clear: false, unstubEnvs: true },
  })
  const test = JSON.parse(source.replace(/^export default /, '')).test
  assert.equal(test.clearMocks, false)
  assert.equal(test.unstubEnvs, true)
  assert.equal('mockReset' in test, false)
})

test('the observe setup is loaded after the trace setup, in both runners, when given', () => {
  const options = { observeSetupFile: '/work/x/.harness-out/observe-setup.ts' }
  assert.deepEqual(jestConfig('/work/x', '/t.ts', '/work/x/trace.ts', options).setupFiles, [
    '/work/x/trace.ts',
    '/work/x/.harness-out/observe-setup.ts',
  ])
  const source = vitestConfigSource('/work/x', '/work/x/trace.ts', 'vitest', options)
  assert.deepEqual(JSON.parse(source.replace(/^export default /, '')).test.setupFiles, [
    '/work/x/trace.ts',
    '/work/x/.harness-out/observe-setup.ts',
  ])
})

test('OBSERVE_SETUP_PATH names the one observe-setup.ts, next to this module', async () => {
  assert.equal(OBSERVE_SETUP_PATH, path.join(import.meta.dirname, 'observe-setup.ts'))
  assert.match(await readFile(OBSERVE_SETUP_PATH, 'utf8'), /target\.observe =/)
})

test('the trace setup appends one line per call, in call order, to the file named by the environment', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'harness-trace-setup-'))
  const saved = process.env[TRACE_ENV]
  const target = globalThis as { trace?: (step: string) => void }
  try {
    const traceFile = path.join(dir, 'trace.txt')
    const setupFile = path.join(dir, 'trace-setup.ts')
    await writeFile(setupFile, traceSetupSource())
    process.env[TRACE_ENV] = traceFile
    await import(setupFile)
    assert.equal(typeof target.trace, 'function')
    target.trace?.('beforeEach L2 #1')
    target.trace?.('test L3a')
    target.trace?.('peak 5')
    assert.equal(await readFile(traceFile, 'utf8'), 'beforeEach L2 #1\ntest L3a\npeak 5\n')
  } finally {
    delete target.trace
    if (saved === undefined) delete process.env[TRACE_ENV]
    else process.env[TRACE_ENV] = saved
    await rm(dir, { recursive: true, force: true })
  }
})

test('the trace setup has no import or require, so Jest can run it as CommonJS and Vitest as ESM', () => {
  const source = traceSetupSource()
  assert.doesNotMatch(source, /^\s*import\b|\brequire\(|\bexport\b/m)
  assert.match(source, new RegExp(`process\\.env\\.${TRACE_ENV}`))
})

test('runnerEnv makes the run quiet, UTC and CI-style, and drops what a parent runner leaks in', () => {
  const env = runnerEnv({
    PATH: '/usr/bin',
    CI: '',
    TZ: 'America/New_York',
    FORCE_COLOR: '1',
    NODE_ENV: 'test',
    NODE_TEST_CONTEXT: 'child-v8',
    JEST_WORKER_ID: '3',
    VITEST: 'true',
  })
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.CI, '1')
  assert.equal(env.NO_COLOR, '1')
  assert.equal(env.TZ, 'UTC')
  for (const name of ['FORCE_COLOR', 'NODE_ENV', 'NODE_TEST_CONTEXT', 'JEST_WORKER_ID', 'VITEST']) {
    assert.equal(name in env, false, name)
  }
})

test('runnerEnv pins the locale: LANG and LC_ALL are C.UTF-8 and no other locale variable survives', () => {
  const base = {
    LANG: 'de_DE.UTF-8',
    LC_ALL: 'fr_FR.UTF-8',
    LC_TIME: 'ja_JP.UTF-8',
    LC_COLLATE: 'sv_SE.UTF-8',
    LC_NUMERIC: 'de_DE.UTF-8',
    LANGUAGE: 'de:en',
    LCX: 'kept',
  }
  const env = runnerEnv(base)
  assert.equal(env.LANG, 'C.UTF-8')
  assert.equal(env.LC_ALL, 'C.UTF-8')
  assert.deepEqual(
    Object.keys(env)
      .filter((name) => name.startsWith('LC_') || name === 'LANGUAGE')
      .sort(),
    ['LC_ALL'],
  )
  assert.equal(env.LCX, 'kept')
  assert.equal(base.LANG, 'de_DE.UTF-8', 'the base environment is not modified')
})

test('runnerEnv lets a fixture override its own variables, last', () => {
  const env = runnerEnv({ PATH: '/bin' }, { TZ: 'Asia/Tokyo', EXTRA: '1' })
  assert.equal(env.TZ, 'Asia/Tokyo')
  assert.equal(env.EXTRA, '1')
})

test('jestEsm gives the transformer its config; without it the transform is the bare path', () => {
  const on = jestConfig('/work/x', '/t.ts', '/s.ts', { jestEsm: true })
  assert.deepEqual(on.transform, { '\\.[cm]?ts$': ['/t.ts', { jestEsm: true }] })
  assert.deepEqual(jestConfig('/work/x', '/t.ts', '/s.ts', {}).transform, {
    '\\.[cm]?ts$': '/t.ts',
  })
})

test('a fixture jestConfig reaches Jest as roots under <rootDir> and the patterns as given', () => {
  const config = jestConfig('/work/x', '/t.ts', '/s.ts', {
    jestConfig: { roots: ['one', 'a/two'], unmockedModulePathPatterns: ['keep'] },
  })
  assert.deepEqual(config.roots, ['<rootDir>/one', '<rootDir>/a/two'])
  assert.deepEqual(config.unmockedModulePathPatterns, ['keep'])
  const plain = jestConfig('/work/x', '/t.ts', '/s.ts', {})
  assert.equal('roots' in plain, false)
  assert.equal('unmockedModulePathPatterns' in plain, false)
})
