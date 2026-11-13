// `RunPoolOptions.startupEnv`: variables Node reads when a forked worker starts (the bin's
// `NODE_COMPILE_CACHE`) and that no test may see, since Jest sets none (D7). They are in the fork's
// spawn environment, so Node acts on them, and gone from its own `process.env` before any file
// loads. Real forks: the test files read the environment themselves.
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { run, runtimeProject, trackedProjects } from './support.ts'

const makeProject = trackedProjects()
const dirs: string[] = []
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})
async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'provino-startup-env-')))
  dirs.push(dir)
  return dir
}

/** A test file that reads `names` from its own environment and from a process it starts. */
function reading(names: readonly string[], expected: Readonly<Record<string, string | undefined>>) {
  return [
    "const { execFileSync } = require('node:child_process')",
    `const expected = ${JSON.stringify(expected)}`,
    `const names = ${JSON.stringify(names)}`,
    "test('the environment a test sees', () => {",
    '  for (const name of names) {',
    '    expect(process.env[name]).toBe(expected[name])',
    "    const script = 'String(process.env[process.argv[1]])'",
    "    const child = execFileSync(process.execPath, ['-p', script, name], { encoding: 'utf8' })",
    '    expect(child.trim()).toBe(String(expected[name]))',
    '  }',
    '})',
    '',
  ].join('\n')
}

describe('RunPoolOptions.startupEnv on forks', () => {
  it('Node sees it at startup (it writes a cache there) and the worker, its tests and their processes never do', async () => {
    const cache = join(await scratch(), 'compile')
    const project = await makeProject({
      'a.test.js': reading(['NODE_COMPILE_CACHE', 'PROVINO_WORKER_STARTUP_ENV'], {}),
      'b.test.js': reading(['NODE_COMPILE_CACHE', 'PROVINO_WORKER_STARTUP_ENV'], {}),
    })
    const { summary } = await run(runtimeProject(project.dir), {
      pool: { kind: 'forks', maxWorkers: 1, startupEnv: { NODE_COMPILE_CACHE: cache } },
    })
    assert.deepEqual(
      summary.files.map((file) => file.state),
      ['pass', 'pass'],
      JSON.stringify(summary.files.map((file) => file.errors)),
    )
    assert.equal(existsSync(cache), true, 'Node enabled the cache from the spawn environment')
    assert.ok(readdirSync(cache).length > 0, 'and made its directory')
  })

  it('leaves every other variable alone, and a variable the caller set itself', async () => {
    const cache = join(await scratch(), 'compile')
    process.env.PROVINO_TEST_KEPT = 'kept'
    try {
      const project = await makeProject({
        'a.test.js': reading(['PROVINO_TEST_KEPT', 'NODE_COMPILE_CACHE'], {
          PROVINO_TEST_KEPT: 'kept',
        }),
      })
      const { summary } = await run(runtimeProject(project.dir), {
        pool: { kind: 'forks', maxWorkers: 1, startupEnv: { NODE_COMPILE_CACHE: cache } },
      })
      assert.deepEqual(
        summary.files.map((file) => file.state),
        ['pass'],
      )
    } finally {
      delete process.env.PROVINO_TEST_KEPT
    }
  })

  it('threads ignore it: they share the process’s environment, and nothing is added to it', async () => {
    const cache = join(await scratch(), 'compile')
    const project = await makeProject({
      'a.test.js': reading(['NODE_COMPILE_CACHE', 'PROVINO_WORKER_STARTUP_ENV'], {}),
    })
    const { summary } = await run(runtimeProject(project.dir), {
      pool: { kind: 'threads', maxWorkers: 1, startupEnv: { NODE_COMPILE_CACHE: cache } },
    })
    assert.deepEqual(
      summary.files.map((file) => file.state),
      ['pass'],
    )
    assert.equal(existsSync(cache), false, 'a thread has no startup of its own to act on it')
  })

  it('no startupEnv, no change: the workers inherit this process’s environment as before', async () => {
    const project = await makeProject({
      'a.test.js': reading(['PROVINO_WORKER_STARTUP_ENV'], {}),
    })
    const { summary } = await run(runtimeProject(project.dir), {
      pool: { kind: 'forks', maxWorkers: 1 },
    })
    assert.deepEqual(
      summary.files.map((file) => file.state),
      ['pass'],
    )
  })
})
