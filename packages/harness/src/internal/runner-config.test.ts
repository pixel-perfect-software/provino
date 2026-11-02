import assert from 'node:assert/strict'
import { test } from 'node:test'
import { jestConfig, runnerEnv, vitestConfigSource } from './runner-config.ts'

test('the Jest config runs *.test.ts except the Vitest-only files, with locations and a local cache', () => {
  const config = jestConfig('/work/x', '/repo/src/jest-transform.ts')
  assert.equal(config.rootDir, '/work/x')
  assert.deepEqual(config.transform, { '\\.[cm]?ts$': '/repo/src/jest-transform.ts' })
  assert.deepEqual(config.testMatch, ['<rootDir>/**/*.test.ts'])
  assert.ok(config.testPathIgnorePatterns.includes('\\.vitest\\.test\\.ts$'))
  assert.equal(config.testLocationInResults, true)
  assert.equal(config.cacheDirectory, '/work/x/.jest-cache')
  assert.equal(config.watchman, false)
  const ignored = new RegExp(config.testPathIgnorePatterns[2] ?? '')
  assert.equal(ignored.test('/work/x/a.vitest.test.ts'), true)
  assert.equal(ignored.test('/work/x/a.jest.test.ts'), false)
})

test('the Vitest config is a plain-object module with globals, task locations and a local cache', () => {
  const source = vitestConfigSource('/work/x')
  assert.match(source, /^export default \{/)
  assert.deepEqual(JSON.parse(source.replace(/^export default /, '')), {
    root: '/work/x',
    cacheDir: '/work/x/.vite',
    test: {
      globals: true,
      includeTaskLocation: true,
      include: ['**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/__goldens__/**', '**/*.jest.test.ts'],
    },
  })
  assert.ok(source.endsWith('\n'))
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
