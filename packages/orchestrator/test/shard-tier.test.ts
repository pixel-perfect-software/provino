// T9.6 and T2.11 in the coordinator: a shard of the files (and the results cache it leaves alone),
// the timings file that cuts it, and the isolation tier a file's docblock or history asks for: a
// `process`-tier file gets a fresh worker of its own. Real forks for the tier (the pids are the
// proof); the shard runs in this process.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  createResultsCache,
  projectCacheKey,
  type RunProjectOptions,
  runProjects,
} from '@provino/orchestrator'
import { createReporterBus } from '@provino/reporters'
import type { RunSummary } from '@provino/types'
import { Collect, run, runtimeProject, trackedProjects } from './support.ts'

const makeProject = trackedProjects()

const passing = (name: string): string => `test('${name}', () => { expect(1).toBe(1) })\n`
const FILES = Object.fromEntries(
  ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => [`${name}.test.js`, passing(name)]),
)
const ALL = Object.keys(FILES)

function ran(summary: RunSummary): string[] {
  return summary.files.map((file) => file.file.path).toSorted()
}

describe('--shard in the coordinator', () => {
  it('runs one shard of the files: path slices under the neutral policy, every file once', async () => {
    const made = await makeProject(FILES)
    const project = runtimeProject(made.dir)
    const shards: string[][] = []
    for (const index of [1, 2, 3]) {
      const { summary } = await run(project, {
        pool: { kind: 'inline' },
        shard: { index, count: 3 },
      })
      assert.equal(summary.reason, 'passed')
      shards.push(ran(summary))
    }
    assert.deepEqual(shards, [
      ['a.test.js', 'b.test.js'],
      ['c.test.js', 'd.test.js'],
      ['e.test.js', 'f.test.js'],
    ])
  })

  it('uses the sha1 split when the policy says so, and cuts by time as soon as the timings file has a time', async () => {
    const made = await makeProject(FILES)
    const project = runtimeProject(made.dir, {
      policy: { orchestrator: { shard: { fallback: 'sha1-slice' } } },
    })
    const bySha1 = ALL.toSorted((a, b) => {
      const [ha, hb] = [sha1(a), sha1(b)]
      return ha < hb ? -1 : 1
    })
    const first = await run(project, { pool: { kind: 'inline' }, shard: { index: 1, count: 3 } })
    assert.deepEqual(ran(first.summary), bySha1.slice(0, 2).toSorted())
    // One time in the file is enough: contiguous cuts by predicted time, whatever the policy.
    await writeFile(
      join(made.dir, 'provino.timings.json'),
      JSON.stringify({
        version: 1,
        files: {
          'a.test.js': 100,
          'b.test.js': 100,
          'c.test.js': 100,
          'd.test.js': 100,
          'e.test.js': 100,
          'f.test.js': 500,
        },
      }),
    )
    const timed = await run(project, { pool: { kind: 'inline' }, shard: { index: 2, count: 2 } })
    assert.deepEqual(ran(timed.summary), ['f.test.js'])
  })

  it('leaves the results cache’s history of the files it did not run', async () => {
    const made = await makeProject(FILES)
    const project = runtimeProject(made.dir)
    // A whole run records every file; a shard afterwards must keep the others' history.
    await run(project, { pool: { kind: 'inline' }, defaultCache: true })
    const read = async (): Promise<string[]> => {
      const text = await readFile(
        join(made.dir, 'node_modules', '.cache', 'provino', 'results.json'),
        'utf8',
      )
      const projects = Object.values(
        (JSON.parse(text) as { projects: Record<string, Record<string, unknown>> }).projects,
      )
      return Object.keys(projects[0] ?? {}).toSorted()
    }
    assert.deepEqual(await read(), ALL)
    await run(project, {
      pool: { kind: 'inline' },
      defaultCache: true,
      shard: { index: 1, count: 3 },
    })
    assert.deepEqual(await read(), ALL)
  })

  it('shards one list across every project of the run, as Jest does', async () => {
    const one = await makeProject(FILES)
    const two = await makeProject(FILES)
    const projects = [
      runtimeProject(one.dir, { name: 'one' }),
      runtimeProject(two.dir, { name: 'two' }),
    ]
    const seen: string[] = []
    for (const index of [1, 2, 3, 4]) {
      const summary = await runProjects(projects, {
        bus: createReporterBus([]),
        cache: false,
        stderr: new Collect(),
        pool: { kind: 'inline' },
        shard: { index, count: 4 },
      })
      seen.push(...summary.files.map((file) => `${file.file.project}/${file.file.path}`))
    }
    assert.deepEqual(
      seen.toSorted(),
      ['one', 'two'].flatMap((name) => ALL.map((file) => `${name}/${file}`)),
    )
  })

  it('cuts the same way in every process when projects have no name and share relative paths', async () => {
    // Unnamed projects get the identity `#<hash of their config>`, and a config with no seed of its
    // own (a Jest config with no `--seed` draws one per process) holds the run's random seed, so the
    // identity differs on every shard's machine. A tie between two files of one relative path must
    // not break on it, or shard 1 and shard 2 can both take the same project's copy and the other
    // copy runs nowhere. Each shard is a separate `runProjects` call here, which draws its own seed
    // as a separate process would.
    const files = { 'a.test.js': passing('a'), 'b.test.js': passing('b') }
    const one = await makeProject(files)
    const two = await makeProject(files)
    const unseeded = (dir: string): ReturnType<typeof runtimeProject> => {
      const { config, ...project } = runtimeProject(dir, { name: '' })
      const { seed: _seed, ...withoutSeed } = config
      return { ...project, config: withoutSeed }
    }
    const projects = [unseeded(one.dir), unseeded(two.dir)]
    const expected = ['one/a.test.js', 'one/b.test.js', 'two/a.test.js', 'two/b.test.js']
    for (let attempt = 0; attempt < 6; attempt++) {
      const seen: string[] = []
      // Three shards of the four files [a, a, b, b]: both pairs of equal paths are split across shards.
      for (const index of [1, 2, 3]) {
        const summary = await runProjects(projects, {
          bus: createReporterBus([]),
          cache: false,
          stderr: new Collect(),
          pool: { kind: 'inline' },
          shard: { index, count: 3 },
        })
        // The first project's files have no `runPath` (it is the run's root); the second's do.
        seen.push(
          ...summary.files.map(
            (file) => `${file.file.runPath === undefined ? 'one' : 'two'}/${file.file.path}`,
          ),
        )
      }
      assert.deepEqual(seen.toSorted(), expected, `attempt ${attempt}`)
    }
  })

  it('refuses --update-timings together with a shard, before anything runs', async () => {
    const made = await makeProject(FILES)
    await assert.rejects(
      run(runtimeProject(made.dir), {
        pool: { kind: 'inline' },
        shard: { index: 1, count: 2 },
        timings: { update: true },
      }),
      { code: 'ORCH_BAD_OPTION', message: /--update-timings.*--shard.*unsharded run/s },
    )
    await assert.rejects(readFile(join(made.dir, 'provino.timings.json'), 'utf8'), {
      code: 'ENOENT',
    })
  })

  it('writes no timings when the run only collects: the durations are not the files', async () => {
    const made = await makeProject(FILES)
    const file = join(made.dir, 'provino.timings.json')
    const project = runtimeProject(made.dir)
    await run(project, {
      pool: { kind: 'inline' },
      collectOnly: true,
      timings: { update: true },
    })
    await assert.rejects(readFile(file, 'utf8'), { code: 'ENOENT' })
    // A run that executes the files does write it.
    await run(project, { pool: { kind: 'inline' }, timings: { update: true } })
    assert.ok(JSON.parse(await readFile(file, 'utf8')).files)
  })

  it('refuses a shard that is not index of count, and a timings file that is not one, before anything runs', async () => {
    const made = await makeProject(FILES)
    const project = runtimeProject(made.dir)
    const options: Partial<RunProjectOptions> = { pool: { kind: 'inline' } }
    await assert.rejects(run(project, { ...options, shard: { index: 3, count: 2 } }), {
      code: 'ORCH_BAD_OPTION',
    })
    await writeFile(
      join(made.dir, 'provino.timings.json'),
      '{"version":1,"files":{"a.test.js":"slow"}}',
    )
    await assert.rejects(run(project, { ...options, shard: { index: 1, count: 2 } }), {
      code: 'ORCH_BAD_TIMINGS',
    })
  })
})

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

describe('the isolation tier of a file (T2.11): process is a fresh worker', () => {
  const log = join(tmpdir(), `provino-tier-${randomUUID()}`)
  afterEach(() => {
    delete process.env.PROVINO_PID_LOG
  })

  /** A test file that notes the pid of the worker it runs in. */
  const noting = (name: string, docblock = ''): string =>
    `${docblock}require('node:fs').appendFileSync(process.env.PROVINO_PID_LOG, '${name} ' + process.pid + '\\n')\n${passing(name)}`

  /** The pid each file ran in, by file name (the log is read once the run is over). */
  function pids(): Map<string, number> {
    const found = new Map<string, number>()
    for (const line of readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
      const [name, pid] = line.split(' ')
      found.set(name as string, Number(pid))
    }
    return found
  }

  async function runNoting(
    files: Readonly<Record<string, string>>,
    options: Partial<RunProjectOptions> & { project?: Parameters<typeof runtimeProject>[1] } = {},
  ): Promise<{ summary: RunSummary; stderr: Collect; pids: Map<string, number>; dir: string }> {
    const { project: projectOptions, ...rest } = options
    const made = await makeProject(files)
    await mkdir(dirname(log), { recursive: true })
    await writeFile(log, '')
    process.env.PROVINO_PID_LOG = log
    const result = await run(runtimeProject(made.dir, projectOptions), {
      pool: { kind: 'forks', maxWorkers: 2 },
      ...rest,
    })
    return { ...result, pids: pids(), dir: made.dir }
  }

  it('gives a file with `@provino-isolate process` a worker of its own, and every other file the project’s', async () => {
    const { summary, pids: pid } = await runNoting({
      'a.test.js': noting('a'),
      'b.test.js': noting('b'),
      'c.test.js': noting('c'),
      'p1.test.js': noting('p1', '/**\n * @provino-isolate process\n */\n'),
      'p2.test.js': noting('p2', '/**\n * @provino-isolate process\n */\n'),
    })
    assert.equal(summary.reason, 'passed')
    const [p1, p2] = [pid.get('p1'), pid.get('p2')]
    assert.ok(p1 !== undefined && p2 !== undefined)
    assert.notEqual(p1, p2, 'two process-tier files do not share a worker')
    for (const name of ['a', 'b', 'c']) {
      assert.notEqual(pid.get(name), p1, `${name} did not run in p1's worker`)
      assert.notEqual(pid.get(name), p2, `${name} did not run in p2's worker`)
    }
    // The workers are all gone: `run` checked the pids it recorded.
  })

  it('a project at `process` runs every file in a fresh worker', async () => {
    const files = Object.fromEntries(['a', 'b', 'c', 'd'].map((n) => [`${n}.test.js`, noting(n)]))
    const made = await makeProject(files)
    await writeFile(log, '')
    process.env.PROVINO_PID_LOG = log
    const base = runtimeProject(made.dir)
    const { summary } = await run(
      { ...base, isolation: 'process' },
      { pool: { kind: 'forks', maxWorkers: 2 } },
    )
    assert.equal(summary.reason, 'passed')
    assert.equal(new Set(pids().values()).size, 4, 'one worker for each file')
  })

  it('a docblock below the project’s tier changes nothing, and a value that is no tier is a warning', async () => {
    const stderr = new Collect()
    const { summary, pids: pid } = await runNoting(
      {
        'a.test.js': noting('a', '/** @provino-isolate none */\n'),
        'b.test.js': noting('b', '/** @provino-isolate bogus */\n'),
        'c.test.js': noting('c'),
      },
      { stderr, pool: { kind: 'forks', maxWorkers: 1 } },
    )
    assert.equal(summary.reason, 'passed')
    assert.equal(new Set(pid.values()).size, 1, 'one worker ran all three: nothing was raised')
    assert.equal(stderr.text.match(/is not an isolation tier/g)?.length, 1, stderr.text)
    assert.match(
      stderr.text,
      /Provino: warning: b\.test\.js: @provino-isolate "bogus" is not an isolation tier/,
    )
  })

  it('a tier the results cache learned for the file raises it the same way', async () => {
    const made = await makeProject({
      'a.test.js': noting('a'),
      'b.test.js': noting('b'),
      'learned.test.js': noting('learned'),
    })
    const project = runtimeProject(made.dir)
    const cache = createResultsCache(join(made.dir, '.cache'))
    cache.record(projectCacheKey(project), 'learned.test.js', {
      durationMs: 1,
      failed: false,
      tests: 1,
      at: 0,
      tier: 'process',
    })
    await writeFile(log, '')
    process.env.PROVINO_PID_LOG = log
    const { summary } = await run(project, {
      pool: { kind: 'forks', maxWorkers: 1 },
      cache,
    })
    assert.equal(summary.reason, 'passed')
    const pid = pids()
    assert.notEqual(pid.get('learned'), pid.get('a'))
    assert.notEqual(pid.get('learned'), pid.get('b'))
  })
})
