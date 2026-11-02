import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isCi, readEnvironment, readRunRef } from './environment.ts'
import { BenchError } from './errors.ts'

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
})

test('outside a git checkout the run ref fails with a stable code', () => {
  assert.throws(
    () => readRunRef({ cwd: process.env.TMPDIR ?? '/tmp' }),
    (error) => error instanceof BenchError && error.code === 'BENCH_GIT_UNAVAILABLE',
  )
})
