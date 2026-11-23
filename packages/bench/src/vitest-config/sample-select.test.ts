import assert from 'node:assert/strict'
import { test } from 'provino'
import {
  candidateKind,
  declaresTest,
  emptyTally,
  isExcludedPath,
  PER_REPO_CAP,
  quotasFull,
  SAMPLE_QUOTAS,
  takeConfigs,
} from './sample-select.ts'

test('a config is vitest.config.* or vite.config.*, outside fixtures, templates, e2e and node_modules', () => {
  assert.equal(candidateKind('vitest.config.ts'), 'vitest.config')
  assert.equal(candidateKind('packages/a/vite.config.mjs'), 'vite.config')
  assert.equal(candidateKind('vitest.config.json'), undefined)
  assert.equal(candidateKind('vitest.workspace.ts'), undefined)
  assert.equal(candidateKind('vitest.base.config.ts'), undefined)
  assert.equal(candidateKind('test/fixtures/a/vitest.config.ts'), undefined)
  assert.equal(candidateKind('templates/app/vite.config.ts'), undefined)
  assert.equal(candidateKind('e2e/vitest.config.ts'), undefined)
  assert.equal(candidateKind('node_modules/x/vitest.config.ts'), undefined)
  assert.equal(isExcludedPath('apps/web/vite.config.ts'), false)
})

test('a vite.config counts only when it declares a test property', () => {
  assert.equal(declaresTest('export default defineConfig({ test: { globals: true } })'), true)
  assert.equal(declaresTest('export default {\n  plugins: [],\n  test: {},\n}'), true)
  assert.equal(
    declaresTest('export default defineConfig({ plugins: [react()], server: {} })'),
    false,
  )
  assert.equal(declaresTest('const latest = 1'), false)
})

test('configs are taken shallowest first, up to the cap, while their kind has room', () => {
  const tally = emptyTally()
  const candidates = [
    'a/b/c/vitest.config.ts',
    'vitest.config.ts',
    'packages/x/vite.config.ts',
    'packages/y/vite.config.ts',
    ...Array.from({ length: 8 }, (_, index) => `pkgs/p${index}/vitest.config.ts`),
  ]
  const taken = takeConfigs(candidates, (path) => path.includes('/x/'), tally)
  assert.equal(taken.length, PER_REPO_CAP)
  assert.equal(taken[0]?.path, 'vitest.config.ts')
  assert.ok(
    !taken.some((entry) => entry.path.includes('/y/')),
    'a vite.config with no test is left out',
  )
  assert.ok(taken.some((entry) => entry.path === 'packages/x/vite.config.ts'))
  assert.equal(tally['vite.config'], 1)
  assert.equal(tally['vitest.config'], PER_REPO_CAP - 1)
})

test('a kind whose quota is full takes no more, and the sample is full when both are', () => {
  const tally = { 'vitest.config': SAMPLE_QUOTAS['vitest.config'], 'vite.config': 0 }
  assert.deepEqual(
    takeConfigs(['vitest.config.ts'], () => true, tally),
    [],
  )
  assert.equal(quotasFull(tally), false)
  tally['vite.config'] = SAMPLE_QUOTAS['vite.config']
  assert.equal(quotasFull(tally), true)
})
