import assert from 'node:assert/strict'
import { test } from 'node:test'
import { jestConfig, vitestConfigSource } from './runner-config.ts'

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
