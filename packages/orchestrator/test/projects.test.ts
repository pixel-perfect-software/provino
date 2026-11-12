// `runProjects` (D29): several projects through one pool, over real forked workers.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { ResolvedProject } from '@provino/config'
import { fileIdOf, OrchestratorError, runProjects } from '@provino/orchestrator'
import { createReporterBus } from '@provino/reporters'
import type { Reporter } from '@provino/types'
import { Collect, runtimeProject, trackedProjects } from './support.ts'

const makeProject = trackedProjects()

const passing = (label: string): string =>
  [
    `// ${label}`,
    "describe('suite', () => {",
    "  test('first', () => { expect(1).toBe(1) })",
    '})',
  ].join('\n')

interface Seen {
  readonly queued: { project: string; path: string; fileId: string }[]
  readonly started: { project: string; path: string; workerId: number }[]
  readonly ended: { project: string; path: string; state: string }[]
  readonly runStarts: { projects: readonly string[]; files: number }[]
  readonly runEnds: string[]
}

function recorder(): { reporter: Reporter; seen: Seen } {
  const seen: Seen = { queued: [], started: [], ended: [], runStarts: [], runEnds: [] }
  const reporter: Reporter = {
    name: 'recorder',
    'run:start': (info, files) => {
      seen.runStarts.push({ projects: info.projects, files: files.length })
    },
    'file:queued': (file) => {
      seen.queued.push({ project: file.project, path: file.path, fileId: file.fileId })
    },
    'file:start': (file, workerId) => {
      seen.started.push({ project: file.project, path: file.path, workerId })
    },
    'file:end': (result) => {
      seen.ended.push({
        project: result.file.project,
        path: result.file.path,
        state: result.state,
      })
    },
    'run:end': (summary) => {
      seen.runEnds.push(summary.reason)
    },
  }
  return { reporter, seen }
}

describe('runProjects over forks', () => {
  it('runs two projects in one pool: one run, projects queued in order, a worker per project', async () => {
    const a = await makeProject({
      'a1.test.js': passing('a1'),
      'a2.test.js': passing('a2'),
      'same.test.js': passing('a'),
    })
    const b = await makeProject({
      'b1.test.js': passing('b1'),
      'same.test.js': passing('b'),
    })
    const { reporter, seen } = recorder()
    const summary = await runProjects(
      [runtimeProject(a.dir, { name: 'alpha' }), runtimeProject(b.dir, { name: 'beta' })],
      {
        bus: createReporterBus([reporter]),
        cache: false,
        stderr: new Collect(),
        pool: { kind: 'forks', maxWorkers: 3 },
      },
    )

    assert.equal(summary.reason, 'passed')
    assert.equal(summary.files.length, 5)
    assert.ok(summary.files.every((file) => file.state === 'pass'))
    // One run for every project.
    assert.deepEqual(seen.runStarts, [{ projects: ['alpha', 'beta'], files: 5 }])
    assert.deepEqual(seen.runEnds, ['passed'])
    // The first project's files, then the second's; the project is on every file.
    assert.deepEqual(
      seen.queued.map((file) => file.project),
      ['alpha', 'alpha', 'alpha', 'beta', 'beta'],
    )
    // A file name two projects share is two files, with ids of their own.
    const same = seen.queued.filter((file) => file.path === 'same.test.js')
    assert.equal(same.length, 2)
    assert.notEqual(same[0]?.fileId, same[1]?.fileId)
    assert.equal(same[0]?.fileId, fileIdOf('alpha', 'same.test.js'))
    assert.equal(same[1]?.fileId, fileIdOf('beta', 'same.test.js'))
    // Every file started and ended once, and a worker only ever ran one project's files.
    assert.equal(seen.started.length, 5)
    assert.equal(seen.ended.length, 5)
    const projectOfWorker = new Map<number, string>()
    for (const start of seen.started) {
      const known = projectOfWorker.get(start.workerId)
      assert.ok(
        known === undefined || known === start.project,
        `worker ${start.workerId} ran ${known} and ${start.project}`,
      )
      projectOfWorker.set(start.workerId, start.project)
    }
    // The cap is for the run, not for each project.
    assert.ok(projectOfWorker.size <= 3 + 2, 'workers started')
    assert.deepEqual([...new Set(projectOfWorker.values())].sort(), ['alpha', 'beta'])
  })

  it('a failing file in one project fails the run, and its project name is on the result', async () => {
    const a = await makeProject({ 'ok.test.js': passing('ok') })
    const b = await makeProject({
      'bad.test.js': "test('fails', () => { expect(1).toBe(2) })",
    })
    const { reporter, seen } = recorder()
    const summary = await runProjects(
      [runtimeProject(a.dir, { name: 'alpha' }), runtimeProject(b.dir, { name: 'beta' })],
      {
        bus: createReporterBus([reporter]),
        cache: false,
        stderr: new Collect(),
        pool: { kind: 'forks', maxWorkers: 2 },
      },
    )
    assert.equal(summary.reason, 'failed')
    assert.deepEqual(seen.ended.map((file) => `${file.project}:${file.state}`).sort(), [
      'alpha:pass',
      'beta:fail',
    ])
  })

  it('two projects with the same name still get workers of their own', async () => {
    const a = await makeProject({ 'x.test.js': passing('a') })
    const b = await makeProject({ 'x.test.js': passing('b') })
    const { reporter, seen } = recorder()
    const summary = await runProjects(
      [runtimeProject(a.dir, { name: '' }), runtimeProject(b.dir, { name: '' })],
      {
        bus: createReporterBus([reporter]),
        cache: false,
        stderr: new Collect(),
        pool: { kind: 'forks', maxWorkers: 1 },
      },
    )
    assert.equal(summary.reason, 'passed')
    assert.equal(summary.files.length, 2)
    const [first, second] = seen.queued
    assert.notEqual(first?.fileId, second?.fileId)
  })

  it('identical discovery and name, different config: each project runs its own', async () => {
    // Same root, same globs, no name: only `setupFiles` tells them apart. Each file must run under
    // the project that discovered it, not under the last project with that identity.
    const dir = await makeProject({
      'setup-a.js': "globalThis.__which = 'a'",
      'probe.test.js': [
        "const { appendFileSync } = require('node:fs')",
        "const { join } = require('node:path')",
        "test('probe', () => {",
        "  appendFileSync(join(__dirname, 'seen.txt'), `${globalThis.__which ?? 'none'}\\n`)",
        '})',
      ].join('\n'),
    })
    const plain = runtimeProject(dir.dir, { name: '' })
    const withSetup: ResolvedProject = {
      ...plain,
      config: { ...plain.config, setupFiles: [join(dir.dir, 'setup-a.js')] },
    }
    const { reporter, seen } = recorder()
    const summary = await runProjects([plain, withSetup], {
      bus: createReporterBus([reporter]),
      cache: false,
      stderr: new Collect(),
      pool: { kind: 'forks', maxWorkers: 2 },
    })
    assert.equal(summary.reason, 'passed')
    assert.equal(summary.files.length, 2)
    assert.notEqual(seen.queued[0]?.fileId, seen.queued[1]?.fileId)
    const lines = readFileSync(join(dir.dir, 'seen.txt'), 'utf8').trim().split('\n').sort()
    assert.deepEqual(lines, ['a', 'none'])
  })

  it('no project is ORCH_NO_PROJECTS, before the bus hears of anything', async () => {
    const { reporter, seen } = recorder()
    await assert.rejects(
      runProjects([], { bus: createReporterBus([reporter]), cache: false }),
      (error: unknown) => error instanceof OrchestratorError && error.code === 'ORCH_NO_PROJECTS',
    )
    assert.deepEqual(seen.runStarts, [])
  })

  it('projects that find no file are a run with no files', async () => {
    const a = await makeProject({ 'readme.md': '' })
    const b = await makeProject({ 'notes.txt': '' })
    const { reporter, seen } = recorder()
    const summary = await runProjects(
      [runtimeProject(a.dir, { name: 'a' }), runtimeProject(b.dir, { name: 'b' })],
      {
        bus: createReporterBus([reporter]),
        cache: false,
        stderr: new Collect(),
        pool: { kind: 'forks', maxWorkers: 2 },
      },
    )
    assert.deepEqual(summary.files, [])
    assert.deepEqual(seen.runStarts, [{ projects: ['a', 'b'], files: 0 }])
  })
})
