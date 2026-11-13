// B11's acceptance check: a test that segfaults its worker fails that file, with the cause, and
// nothing else. Real forked workers, through `run()` and through the `provino` bin.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { run } from 'provino/node'
import {
  Collect,
  isRunning,
  notedPids,
  noting,
  type Project,
  QUIET_ENV,
  spawnCli,
  trackedProjects,
  viewOfNormalized,
} from './support.ts'

const makeProject = trackedProjects()

const PASSING = ['tests/a.test.js', 'tests/b.test.js', 'tests/c.test.js'] as const

/** Four files; `tests/boom.test.js` kills its own process with SIGSEGV in its only test. */
function crashingProject(): Promise<Project> {
  return makeProject((dir) => {
    const pids = join(dir, 'workers.pids')
    return {
      // The largest file, so it is the first one a worker takes.
      'tests/boom.test.js': [
        "const { appendFileSync } = require('node:fs')",
        "test('about to crash', () => {",
        `  appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n')`,
        "  process.kill(process.pid, 'SIGSEGV')",
        '})',
        `// ${'z'.repeat(400)}`,
      ].join('\n'),
      'tests/a.test.js': noting('a', pids),
      'tests/b.test.js': noting('b', pids),
      'tests/c.test.js': noting('c', pids),
    }
  })
}

/** Asserts the normalized JSON says: boom crashed because of SIGSEGV, and nothing else did. */
function assertCrashedInJson(text: string): void {
  const view = viewOfNormalized(text)
  assert.equal(view.schemaVersion, 1)
  assert.equal(view.success, false)
  assert.equal(view.files.size, 4)
  const boom = view.files.get('tests/boom.test.js')
  assert.equal(boom?.status, 'crashed')
  assert.match(boom?.fileError ?? '', /SIGSEGV/)
  for (const path of PASSING) {
    assert.equal(view.files.get(path)?.status, 'passed', path)
  }
}

describe('a test that segfaults its worker', { skip: process.platform === 'win32' }, () => {
  it('through run(): that file fails with the cause, every other file passes, every worker has exited', async () => {
    const project = await crashingProject()
    const outputFile = project.path('run.json')
    const stderr = new Collect()
    const stdout = new Collect()

    const result = await run({
      config: project.config,
      pool: 'forks',
      maxWorkers: 2,
      reporters: ['default', ['normalized-json', { outputFile }]],
      env: QUIET_ENV,
      stdout,
      stderr,
    })

    assert.equal(result.exitCode, 1)
    assert.equal(result.summary?.reason, 'failed')

    const byPath = new Map(result.summary?.files.map((file) => [file.file.path, file]))
    assert.equal(byPath.size, 4)
    const boom = byPath.get('tests/boom.test.js')
    assert.equal(boom?.state, 'fail')
    assert.deepEqual(boom?.workerExit, { type: 'signal', signal: 'SIGSEGV', likelyOom: false })
    for (const path of PASSING) {
      assert.equal(byPath.get(path)?.state, 'pass', path)
    }

    // The default reporter.
    assert.match(stderr.text, /FAIL tests\/boom\.test\.js/)
    assert.match(stderr.text, /killed by SIGSEGV/)
    assert.match(stderr.text, /Test Suites: 1 failed, 3 passed, 4 total/)
    for (const path of PASSING) {
      assert.match(stderr.text, new RegExp(`PASS ${path.replace('.', '\\.')}`))
    }
    assert.equal(stdout.text, '')

    // The normalized-json reporter.
    assertCrashedInJson(await readFile(outputFile, 'utf8'))

    // Every worker is gone: the crashed one and the ones that ran the other files.
    const pids = await notedPids(project.path('workers.pids'))
    assert.ok(pids.length >= 4, `every file noted a pid (saw ${pids.length})`)
    assert.ok(
      pids.every((pid) => !isRunning(pid)),
      'no worker outlived the run',
    )
  })

  it('through the bin: exit 1, the same output, and the process ends by itself', async () => {
    const project = await crashingProject()
    const outputFile = project.path('run.json')

    const ended = await spawnCli(
      [
        'run',
        '--config',
        project.config,
        '--pool',
        'forks',
        '--maxWorkers',
        '2',
        '--reporter',
        'default',
        '--reporter',
        'normalized-json',
        '--outputFile',
        outputFile,
      ],
      { cwd: project.dir },
    )

    assert.equal(ended.signal, null, 'it exited, it was not killed')
    assert.equal(ended.code, 1, ended.stderr)
    assert.match(ended.stderr, /FAIL tests\/boom\.test\.js/)
    assert.match(ended.stderr, /killed by SIGSEGV/)
    assert.equal(ended.stdout, '')
    assertCrashedInJson(await readFile(outputFile, 'utf8'))

    const pids = await notedPids(project.path('workers.pids'))
    assert.ok(
      pids.every((pid) => !isRunning(pid)),
      'no worker outlived the process',
    )
  })

  it('with a single worker, the files after the crash still run on a new one', async () => {
    const project = await crashingProject()
    const result = await run({
      config: project.config,
      pool: 'forks',
      maxWorkers: 1,
      reporters: [],
      stderr: new Collect(),
    })

    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.summary?.files.map((file) => [file.file.path, file.state]).sort(), [
      ['tests/a.test.js', 'pass'],
      ['tests/b.test.js', 'pass'],
      ['tests/boom.test.js', 'fail'],
      ['tests/c.test.js', 'pass'],
    ])
  })
})
