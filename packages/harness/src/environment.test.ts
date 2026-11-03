import assert from 'node:assert/strict'
import { availableParallelism } from 'node:os'
import { test } from 'node:test'
import { readRunEnvironment } from './environment.ts'

test('the environment names the machine, Node and the runners', () => {
  const runners = { jest: '30.5.2' }
  const env = readRunEnvironment(runners, {})
  assert.equal(env.os, process.platform)
  assert.equal(env.arch, process.arch)
  assert.equal(env.node, process.version)
  assert.deepEqual(env.runners, runners)
  assert.equal(typeof env.osRelease, 'string')
  assert.equal(typeof env.cpuModel, 'string')
  assert.ok(env.memoryMb > 0 && Number.isInteger(env.memoryMb))
})

test('the CPU count is the parallelism this process may use', () => {
  assert.equal(readRunEnvironment({}, {}).cpuCount, availableParallelism())
})

test('CI is on for any value but unset, empty, 0 or false, in any case and with spaces', () => {
  const ci = (value: string | undefined): boolean =>
    readRunEnvironment({}, value === undefined ? {} : { CI: value }).ci
  for (const off of [undefined, '', ' ', '0', ' 0 ', 'false', 'FALSE', 'False']) {
    assert.equal(ci(off), false, String(off))
  }
  for (const on of ['1', 'true', 'TRUE', 'yes', 'github-actions']) {
    assert.equal(ci(on), true, on)
  }
})

test('without an environment it reads the process’s own', () => {
  const saved = process.env.CI
  try {
    process.env.CI = 'true'
    assert.equal(readRunEnvironment({}).ci, true)
    process.env.CI = '0'
    assert.equal(readRunEnvironment({}).ci, false)
  } finally {
    if (saved === undefined) delete process.env.CI
    else process.env.CI = saved
  }
})
