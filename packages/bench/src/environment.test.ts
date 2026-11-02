import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { isCi, readEnvironment, readRunRef, requireCleanTree } from './environment.ts'
import { BenchError } from './errors.ts'
import { makeRepo } from './internal/test-repo.ts'

test('CI is on when the variable is set to anything but empty, 0 or false', () => {
  assert.equal(isCi({ CI: 'true' }), true)
  assert.equal(isCi({ CI: '1' }), true)
  assert.equal(isCi({ CI: '' }), false)
  assert.equal(isCi({ CI: '0' }), false)
  assert.equal(isCi({ CI: 'FALSE' }), false)
  assert.equal(isCi({}), false)
})

test('the environment describes this machine and carries the runner versions', () => {
  const environment = readEnvironment({ jest: '30.5.2' }, { CI: 'true' })
  assert.equal(environment.os, process.platform)
  assert.equal(environment.arch, process.arch)
  assert.equal(environment.node, process.version)
  assert.equal(environment.ci, true)
  assert.deepEqual(environment.runners, { jest: '30.5.2' })
  assert.ok(environment.cpuCount >= 1)
  assert.ok(environment.memoryMb > 0)
  assert.ok(environment.cpuModel.length > 0)
  assert.ok(environment.osRelease.length > 0)
})

test('the run ref is this checkout’s commit and the given time', () => {
  const ref = readRunRef({ now: new Date('2026-11-02T10:11:12.000Z') })
  assert.match(ref.sha, /^[0-9a-f]{40}$/)
  assert.equal(ref.date, '2026-11-02T10:11:12.000Z')
  assert.equal(typeof ref.dirty, 'boolean')
})

async function repoDir(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'bench-env-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return join(dir, 'repo')
}

test('the run ref says whether git status was clean', async (t) => {
  const clean = await repoDir(t)
  await makeRepo(clean)
  assert.equal(readRunRef({ cwd: clean }).dirty, false)

  // untracked files count: git status --porcelain is not empty
  await writeFile(join(clean, 'new.txt'), 'x')
  assert.equal(readRunRef({ cwd: clean }).dirty, true)

  const dirty = await repoDir(t)
  await makeRepo(dirty, { dirty: true })
  assert.equal(readRunRef({ cwd: dirty }).dirty, true)
})

test('outside a git checkout the run ref fails with a stable code', () => {
  assert.throws(
    () => readRunRef({ cwd: process.env.TMPDIR ?? '/tmp' }),
    (error) => error instanceof BenchError && error.code === 'BENCH_GIT_UNAVAILABLE',
  )
})

test('a dirty tree is refused for desktop and pinned records only', () => {
  const dirty = { sha: 'a'.repeat(40), date: '2026-11-02T10:00:00.000Z', dirty: true }
  const clean = { ...dirty, dirty: false }
  for (const label of ['desktop', 'pinned'] as const) {
    assert.throws(
      () => requireCleanTree(label, dirty),
      (error) =>
        error instanceof BenchError &&
        error.code === 'BENCH_DIRTY_TREE' &&
        error.message.includes(label),
      label,
    )
    requireCleanTree(label, clean)
  }
  requireCleanTree('local', dirty)
  requireCleanTree('local', clean)
})
