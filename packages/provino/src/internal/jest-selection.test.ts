// Which errors of the changed-files lookup `provino jest` prints as Jest's red text: only a
// command the provider ran that failed. A broken install, a bug or a refused dialect propagates
// with its stack.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'provino'
import type { ResolvedProject } from '@provino/config'
import { jestChangedFiles } from '@provino/dialect-jest/affected'
import { createResultsCache, projectCacheKey } from '@provino/orchestrator'
import { isScmCommandFailure, previousDurations } from './jest-selection.ts'

test('a failing SCM command is the provider’s own failure', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'provino-scm-')))
  const saved = { ...process.env }
  // A repository of its own, with nothing read from this machine's git config.
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: dirname(dir),
  })
  try {
    execFileSync('git', ['init', '-q', '--template='], { cwd: dir, stdio: 'ignore' })
    // `git diff --name-only nope...HEAD` fails with exit 128.
    const failure = await jestChangedFiles({ roots: [dir], changedSince: 'nope' }).then(
      () => assert.fail('the lookup resolved'),
      (error: unknown) => error,
    )
    assert.equal(isScmCommandFailure(failure), true)
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
    Object.assign(process.env, saved)
    await rm(dir, { recursive: true, force: true })
  }
})

test('any other error is not, so it keeps its stack', () => {
  assert.equal(isScmCommandFailure(new TypeError('Cannot read properties of undefined')), false)
  assert.equal(
    isScmCommandFailure(Object.assign(new Error('not built'), { code: 'ORCH_NOT_IMPLEMENTED' })),
    false,
  )
  assert.equal(
    isScmCommandFailure(
      Object.assign(new Error('load failed'), { code: 'POLICY_BEHAVIOUR_LOAD_FAILED' }),
    ),
    false,
  )
  assert.equal(isScmCommandFailure('Command failed with exit code 128: git'), false)
})

test('shouldRunTestSuite\u2019s duration is the results cache\u2019s last run time, none without history', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'provino-durations-')))
  try {
    // Only what the cache key and directory read.
    const project = {
      name: 'p',
      rootDir: dir,
      include: ['**'],
      exclude: [],
      discovery: null,
      cacheDirectory: join(dir, 'cache'),
    } as unknown as ResolvedProject
    const cache = createResultsCache(join(dir, 'cache', 'provino'))
    cache.record(projectCacheKey(project), 'a.test.ts', {
      durationMs: 123,
      failed: false,
      tests: 1,
      at: 1,
    })
    await cache.write()
    const durationOf = previousDurations(project, true)
    assert.equal(durationOf('a.test.ts'), 123)
    assert.equal(durationOf('b.test.ts'), undefined)
    assert.equal(
      previousDurations(project, false)('a.test.ts'),
      undefined,
      '--no-cache: no history',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
