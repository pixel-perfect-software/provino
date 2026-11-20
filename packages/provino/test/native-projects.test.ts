// B27d, acceptance row 6: `projects` (inline objects, a directory and a glob, each with its own
// config) run in one invocation, each with its own include, setup files and timeouts. The test
// files use the Jest dialect's globals: the native API is B27b's.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { run } from 'provino/node'
import { Collect, QUIET_ENV, trackedProjects } from './support.ts'

const makeProject = trackedProjects()

async function runProject(config: string, files: Readonly<Record<string, string>> = {}) {
  const project = await makeProject(files, config)
  const stderr = new Collect()
  const result = await run({
    config: project.config,
    stdout: new Collect(),
    stderr,
    env: QUIET_ENV,
  })
  return { ...result, stderr: stderr.text }
}

const FILES: Readonly<Record<string, string>> = {
  'one/a.test.js': "test('one', () => { expect(globalThis.__setup).toBe(undefined) })\n",
  'pkgs/a/provino.config.mjs':
    "export default { dialect: 'jest', include: ['t/*.test.js'], setupFiles: ['./setup.js'] }\n",
  'pkgs/a/setup.js': "globalThis.__setup = 'a'\n",
  'pkgs/a/t/x.test.js': "test('a', () => { expect(globalThis.__setup).toBe('a') })\n",
  'pkgs/b/provino.config.mjs':
    "export default { dialect: 'jest', include: ['t/*.test.js'], timeouts: { test: 50 } }\n",
  'pkgs/b/t/y.test.js': "test('b', () => { expect(globalThis.__setup).toBe(undefined) })\n",
  'pkgs/b/t/hang.test.js': "test('hangs', () => new Promise(() => {}))\n",
}

describe('projects', () => {
  it('runs inline projects, a directory and a glob in one invocation, each with its own keys', async () => {
    const config = `export default { projects: [
      { name: 'one', dialect: 'jest', root: 'one', include: ['*.test.js'] },
      'pkgs/a',
      'pkgs/b',
    ] }\n`
    const ran = await runProject(config, FILES)
    // b's own 50 ms timeout fails its hanging test; a's setup file ran only in a's workers.
    assert.equal(ran.exitCode, 1, ran.stderr)
    const states = new Map(ran.summary?.files.map((file) => [file.file.path, file.state]))
    assert.equal(states.get('a.test.js'), 'pass')
    assert.equal(states.get('t/x.test.js'), 'pass')
    assert.equal(states.get('t/y.test.js'), 'pass')
    assert.equal(states.get('t/hang.test.js'), 'fail')
    assert.match(ran.stderr, /Exceeded timeout of 50 ms/)
  })

  it('a glob finds the directories, each named for its directory', async () => {
    const config = "export default { projects: ['pkgs/*'] }\n"
    const ran = await runProject(config, FILES)
    assert.equal(ran.exitCode, 1, ran.stderr)
    assert.equal(ran.summary?.files.length, 3)
  })

  it('two projects with one name are a usage error: exit 2, no file runs', async () => {
    const config = `export default { projects: [
      { name: 'p', include: ['a'] }, { name: 'p', include: ['b'] } ] }\n`
    const ran = await runProject(config)
    assert.equal(ran.exitCode, 2)
    assert.equal(ran.summary, null)
    assert.match(ran.stderr, /two projects are named "p"/)
  })
})
