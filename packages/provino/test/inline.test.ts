// `run()` with the pools that share or split stdio: an inline pool on several files, and a
// worker's own stdout next to a reporter's JSON on stdout.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { run } from 'provino/node'
import { Collect, passing, QUIET_ENV, trackedProjects, viewOfNormalized } from './support.ts'

const makeProject = trackedProjects()

describe('run() pools', () => {
  it('passes three files on an inline pool whatever maxWorkers says', async () => {
    const project = await makeProject({
      'tests/a.test.js': passing('a'),
      'tests/b.test.js': passing('b'),
      'tests/c.test.js': passing('c'),
    })
    const stdout = new Collect()
    const stderr = new Collect()
    const result = await run({
      config: project.config,
      pool: 'inline',
      maxWorkers: 4,
      stdout,
      stderr,
      env: QUIET_ENV,
    })
    assert.equal(result.exitCode, 0, stderr.text)
    assert.equal(result.summary?.files.length, 3)
  })

  it('keeps a worker’s direct stdout write out of the normalized JSON on stdout', async () => {
    const project = await makeProject({
      'tests/raw.test.js': [
        "const { writeSync } = require('node:fs')",
        "test('writes to fd 1', () => { writeSync(1, 'RAW\\n') })",
      ].join('\n'),
    })
    const stdout = new Collect()
    const stderr = new Collect()
    const result = await run({
      config: project.config,
      pool: 'forks',
      reporters: ['normalized-json'],
      stdout,
      stderr,
    })
    assert.equal(result.exitCode, 0, stderr.text)
    assert.doesNotThrow(() => viewOfNormalized(stdout.text), 'stdout is only the JSON')
    assert.ok(!stdout.text.includes('RAW'))
    assert.match(stderr.text, /RAW/)
  })
})
