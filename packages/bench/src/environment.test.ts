import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readRunRef } from './environment.ts'
import { code, scratch } from './internal/test-helpers.ts'
import { makeRepo } from './internal/test-repo.ts'

test('the run ref is this checkout’s commit and the given time', () => {
  const ref = readRunRef({ now: new Date('2026-11-02T10:11:12.000Z') })
  assert.match(ref.sha, /^[0-9a-f]{40}$/)
  assert.equal(ref.date, '2026-11-02T10:11:12.000Z')
  assert.equal(typeof ref.dirty, 'boolean')
})

test('the run ref says whether git status was clean', async (t) => {
  const clean = join(await scratch(t, 'bench-env-'), 'repo')
  await makeRepo(clean)
  assert.equal(readRunRef({ cwd: clean }).dirty, false)

  // untracked files count: git status --porcelain is not empty
  await writeFile(join(clean, 'new.txt'), 'x')
  assert.equal(readRunRef({ cwd: clean }).dirty, true)

  const dirty = join(await scratch(t, 'bench-env-'), 'repo')
  await makeRepo(dirty, { dirty: true })
  assert.equal(readRunRef({ cwd: dirty }).dirty, true)
})

test('outside a git checkout the run ref fails with a stable code', () => {
  assert.throws(() => readRunRef({ cwd: tmpdir() }), code('BENCH_GIT_UNAVAILABLE'))
})
