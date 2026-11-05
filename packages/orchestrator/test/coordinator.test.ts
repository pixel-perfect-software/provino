// `runProject` end to end: real projects on disk, the fixtures' environment and globals, and real
// forked workers where it matters (a worker killed by a signal, every worker gone afterwards).
// The Jest dialect with the real node environment runs this through `provino/node` in B11's bench
// check; here the orchestrator may not depend on either, so the fixtures stand in.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { ResolvedProject } from '@provino/config'
import {
  createResultsCache,
  defaultCacheDir,
  ExitCode,
  exitCodeFor,
  fileIdOf,
  type RunProjectOptions,
  runProject,
} from '@provino/orchestrator'
import { createReporterBus, type ReporterBusHandle } from '@provino/reporters'
import type { Reporter, RunSummary, TaskId } from '@provino/types'
import {
  Collect,
  isRunning,
  PID_RECORDING_ENTRY,
  runtimeProject,
  takeWorkerPids,
  trackedProjects,
} from './support.ts'

const makeProject = trackedProjects()

/** One thing the recorder saw: the event, the file it belongs to (if any) and what we assert on. */
interface Seen {
  readonly name: string
  readonly fileId: TaskId | null
  readonly detail: Readonly<Record<string, unknown>>
}

function recorder(): { reporter: Reporter; seen: Seen[] } {
  const seen: Seen[] = []
  const note = (name: string, fileId: TaskId | null, detail: Seen['detail'] = {}): void => {
    seen.push({ name, fileId, detail })
  }
  const reporter: Reporter = {
    name: 'recorder',
    'run:start': (_info, files) => note('run:start', null, { files: files.map((f) => f.path) }),
    'file:queued': (file) => note('file:queued', file.fileId, { path: file.path }),
    'file:start': (file, workerId) => note('file:start', file.fileId, { workerId }),
    'file:collected': (file) => note('file:collected', file.fileId),
    'task:start': (task) => note('task:start', task.fileId, { name: task.name }),
    'task:end': (task, event) =>
      note('task:end', task.fileId, {
        name: task.name,
        type: task.type,
        state: event.result.state,
      }),
    console: (file, event) => note('console', file.fileId, { text: event.text }),
    'file:end': (result) => note('file:end', result.file.fileId, { state: result.state }),
    'run:end': (summary) => note('run:end', null, { reason: summary.reason }),
  }
  return { reporter, seen }
}

interface Run {
  readonly summary: RunSummary
  readonly seen: readonly Seen[]
  readonly bus: ReporterBusHandle
  readonly stderr: Collect
  /** The pids of the forked workers that ran, and they are all gone. */
  readonly pids: readonly number[]
}

/**
 * Runs the project with a recording reporter and checks no forked worker outlived the run. The
 * results cache is off, unless `cache` is given or `defaultCache` asks for the project’s own.
 */
async function run(
  project: ResolvedProject,
  options: Partial<RunProjectOptions> & { readonly defaultCache?: boolean } = {},
): Promise<Run> {
  const { defaultCache, ...runOptions } = options
  const { reporter, seen } = recorder()
  const bus = createReporterBus([reporter])
  const stderr = new Collect()
  const summary = await runProject(project, {
    bus,
    stderr,
    ...(defaultCache === true ? {} : { cache: false }),
    // Only forks are processes of their own to record; an inline worker would write the test's.
    ...(runOptions.pool?.kind === 'forks' ? { entry: PID_RECORDING_ENTRY } : {}),
    ...runOptions,
  })
  const pids = await takeWorkerPids()
  for (const pid of pids) assert.equal(isRunning(pid), false, `worker ${pid} is still running`)
  return { summary, seen, bus, stderr, pids }
}

/** The names of the events of one file, in order. */
const namesOf = (seen: readonly Seen[], fileId: TaskId): string[] =>
  seen.filter((entry) => entry.fileId === fileId).map((entry) => entry.name)

const passing = (extra = ''): string =>
  [
    `// ${extra}`,
    "describe('suite', () => {",
    "  test('first', () => { expect(1).toBe(1) })",
    "  test('second', () => { expect(2).toBe(2) })",
    '})',
  ].join('\n')

describe('runProject over forks', () => {
  it('runs a 6-file project on at most 2 workers, with each file’s events in order', async () => {
    // The padding makes the files differ in size, so the order (largest first) is known.
    const files = Object.fromEntries(
      [1, 2, 3, 4, 5, 6].map((n) => [`f${n}.test.js`, passing('x'.repeat(n * 20))]),
    )
    const p = await makeProject(files)
    const project = runtimeProject(p.dir)
    const { summary, seen, bus, pids } = await run(project, {
      pool: { kind: 'forks', maxWorkers: 2 },
    })

    assert.equal(summary.reason, 'passed')
    assert.deepEqual(
      summary.files.map((f) => f.file.path),
      ['f6.test.js', 'f5.test.js', 'f4.test.js', 'f3.test.js', 'f2.test.js', 'f1.test.js'],
      'largest first, with no history',
    )
    assert.ok(summary.files.every((f) => f.state === 'pass' && f.errors.length === 0))
    assert.deepEqual(bus.failures(), [])
    assert.equal(exitCodeFor(summary, { policy: project.policy }), ExitCode.Pass)

    // The run is bracketed by `run:start` and `run:end`; every file is queued before any starts.
    assert.equal(seen[0]?.name, 'run:start')
    assert.equal(seen.at(-1)?.name, 'run:end')
    assert.deepEqual(
      seen[0]?.detail.files,
      summary.files.map((f) => f.file.path),
    )
    const firstStart = seen.findIndex((entry) => entry.name === 'file:start')
    const queued = seen.flatMap((entry, index) => (entry.name === 'file:queued' ? [index] : []))
    assert.equal(queued.length, 6)
    assert.ok(queued.every((index) => index < firstStart))
    assert.deepEqual(
      queued.map((index) => seen[index]?.detail.path),
      summary.files.map((f) => f.file.path),
    )

    // Per file: queued, started, collected, then task events, then ended, nothing after.
    for (const { file } of summary.files) {
      const names = namesOf(seen, file.fileId)
      assert.equal(file.fileId, fileIdOf('rt', file.path))
      assert.deepEqual(
        names.slice(0, 3),
        ['file:queued', 'file:start', 'file:collected'],
        file.path,
      )
      assert.equal(names.at(-1), 'file:end', file.path)
      const middle = names.slice(3, -1)
      assert.ok(middle.length > 0 && middle.every((name) => name.startsWith('task:')), file.path)
      const tests = seen.filter(
        (entry) =>
          entry.fileId === file.fileId && entry.name === 'task:end' && entry.detail.type === 'test',
      )
      assert.deepEqual(
        tests.map((entry) => [entry.detail.name, entry.detail.state]),
        [
          ['first', 'pass'],
          ['second', 'pass'],
        ],
      )
    }

    // At most two workers took files, numbered from 1, and each worker ran one file at a time.
    const workers = seen
      .filter((entry) => entry.name === 'file:start')
      .map((e) => e.detail.workerId)
    assert.deepEqual([...new Set(workers)].sort(), [1, 2])
    assert.equal(pids.length, 2)
  })

  // With one worker the replacement is certain; with two, the survivor may take the next files.
  for (const maxWorkers of [1, 2]) {
    it(`fails a file whose worker is killed by SIGSEGV with the cause, and runs every other file (${maxWorkers} worker${maxWorkers === 1 ? '' : 's'})`, {
      skip: process.platform === 'win32',
    }, async () => {
      const p = await makeProject({
        'a.test.js': passing('a'),
        // The largest file, so it is the first one taken.
        'boom.test.js': [
          "test('about to crash', () => {",
          "  process.kill(process.pid, 'SIGSEGV')",
          '})',
          `// ${'z'.repeat(400)}`,
        ].join('\n'),
        'c.test.js': passing('c'),
        'd.test.js': passing('d'),
        'e.test.js': passing('e'),
      })
      const project = runtimeProject(p.dir)
      const { summary, seen, pids } = await run(project, { pool: { kind: 'forks', maxWorkers } })

      const byPath = new Map(summary.files.map((f) => [f.file.path, f]))
      const boom = byPath.get('boom.test.js')
      assert.equal(boom?.state, 'fail')
      assert.deepEqual(boom?.workerExit, { type: 'signal', signal: 'SIGSEGV', likelyOom: false })
      assert.equal(boom?.errors.length, 1)
      assert.equal(boom?.errors[0]?.name, 'WorkerCrash')
      assert.equal(
        boom?.errors[0]?.message,
        'The worker running boom.test.js exited: killed by SIGSEGV',
      )
      for (const path of ['a.test.js', 'c.test.js', 'd.test.js', 'e.test.js']) {
        assert.equal(byPath.get(path)?.state, 'pass', path)
      }
      assert.equal(summary.files.length, 5)
      assert.equal(summary.reason, 'failed')
      assert.equal(
        exitCodeFor(summary, { policy: project.policy }),
        project.policy.orchestrator.exitCodes.failure,
      )

      // The crashed file ends like any other: `file:end` is its last event.
      const crashedId = boom?.file.fileId
      assert.ok(crashedId !== undefined)
      assert.equal(namesOf(seen, crashedId).at(-1), 'file:end')

      // The crash cost one worker; the files after it ran on others (`run` has checked that
      // none of them, the crashed one included, is still running).
      const workers = seen
        .filter((entry) => entry.name === 'file:start')
        .map((entry) => entry.detail.workerId)
      assert.ok(pids.length >= 2 && pids.length <= 1 + 4)
      if (maxWorkers === 1) {
        assert.deepEqual(
          workers,
          [1, 2, 2, 2, 2],
          'the next file got a new worker, which was reused',
        )
        assert.equal(pids.length, 2)
      }
    })
  }

  it('stops the run and kills the workers when the signal aborts, reporting only what finished', async () => {
    const p = await makeProject({
      // The biggest file runs first (no history) and never ends.
      'a-hangs.test.js': [
        "test('hangs', async () => { await new Promise(() => {}) }, 60000)",
        `// ${'h'.repeat(500)}`,
      ].join('\n'),
      'b.test.js': passing('b'),
      'c.test.js': passing('c'),
    })
    const controller = new AbortController()
    const { reporter, seen } = recorder()
    const abortOnStart: Reporter = {
      name: 'abort-on-start',
      'file:start': () => controller.abort(),
    }
    const bus = createReporterBus([reporter, abortOnStart])
    const summary = await runProject(runtimeProject(p.dir), {
      bus,
      cache: false,
      stderr: new Collect(),
      entry: PID_RECORDING_ENTRY,
      pool: { kind: 'forks', maxWorkers: 1 },
      signal: controller.signal,
    })
    const pids = await takeWorkerPids()

    assert.equal(summary.reason, 'interrupted')
    assert.deepEqual(summary.files, [])
    assert.equal(exitCodeFor(summary, { policy: runtimeProject(p.dir).policy }), ExitCode.Sigint)
    assert.equal(seen.filter((entry) => entry.name === 'file:end').length, 0)
    assert.equal(seen.filter((entry) => entry.name === 'file:start').length, 1)
    assert.equal(seen.at(-1)?.name, 'run:end')
    assert.equal(pids.length, 1)
    for (const pid of pids) assert.equal(isRunning(pid), false)
  })

  it('fails every file, without a hang, when no worker can start', async () => {
    const p = await makeProject(
      Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`f${n}.test.js`, passing(`${n}`)])),
    )
    const { summary, seen, stderr } = await run(runtimeProject(p.dir), {
      pool: { kind: 'forks', maxWorkers: 1, startTimeoutMs: 20_000 },
      // A worker entry that doesn't exist: each worker exits before it says ready.
      entry: new URL('./fixtures/does-not-exist.ts', import.meta.url),
    })
    assert.equal(summary.reason, 'failed')
    assert.equal(summary.files.length, 5)
    assert.ok(summary.files.every((f) => f.state === 'fail'))
    assert.ok(summary.files.every((f) => f.errors[0]?.code === 'ORCH_WORKER_EXITED'))
    assert.ok(summary.files.every((f) => f.workerExit?.type === 'exit'))
    // After the third start failure the rest fail with that error, without another attempt.
    const third = summary.files[2]?.errors[0]?.message
    assert.equal(summary.files[3]?.errors[0]?.message, third)
    assert.equal(summary.files[4]?.errors[0]?.message, third)
    assert.equal(seen.filter((entry) => entry.name === 'file:start').length, 0)
    assert.equal(seen.filter((entry) => entry.name === 'file:end').length, 5)
    assert.ok(stderr.text.length > 0, 'the worker’s own error reached the stderr sink')
  })
})

describe('runProject over inline workers', () => {
  it('replaces a worker whose file left globals behind', async () => {
    const p = await makeProject({
      'a.test.js': passing('aaa'),
      'b.test.js': passing('bb'),
      'c.test.js': passing('c'),
    })
    const leaky = await run(runtimeProject(p.dir, { environmentOptions: { leak: '__stuck' } }), {
      pool: { kind: 'inline', maxWorkers: 1 },
    })
    const workers = leaky.seen
      .filter((entry) => entry.name === 'file:start')
      .map((entry) => entry.detail.workerId)
    assert.deepEqual(workers, [1, 2, 3], 'each file leaked, so each got a new worker')
    assert.equal(leaky.summary.reason, 'passed', 'a leak is a warning, not a failure (D22)')
    const warnings = leaky.seen.filter(
      (entry) => entry.name === 'console' && String(entry.detail.text).includes('left 1 global'),
    )
    assert.equal(warnings.length, 3, 'the worker’s warning reached the reporters')

    const clean = await run(runtimeProject(p.dir), { pool: { kind: 'inline', maxWorkers: 1 } })
    const cleanWorkers = clean.seen
      .filter((entry) => entry.name === 'file:start')
      .map((entry) => entry.detail.workerId)
    assert.deepEqual(cleanWorkers, [1, 1, 1], 'a clean worker is reused')
  })

  it('puts the file that failed last time first on the next run, through the results cache', async () => {
    const p = await makeProject({
      // Largest first with no history: big, then mid, then the failing small one.
      'big.test.js': passing('b'.repeat(300)),
      'mid.test.js': passing('m'.repeat(150)),
      'small-fails.test.js': "test('fails', () => { expect(1).toBe(2) })",
    })
    const project = runtimeProject(p.dir)
    const queuedOrder = (seen: readonly Seen[]): unknown[] =>
      seen.filter((entry) => entry.name === 'file:queued').map((entry) => entry.detail.path)

    // No `cache` option: the default directory under the project.
    const first = await run(project, {
      defaultCache: true,
      pool: { kind: 'inline', maxWorkers: 1 },
    })
    assert.deepEqual(queuedOrder(first.seen), ['big.test.js', 'mid.test.js', 'small-fails.test.js'])
    assert.equal(first.summary.reason, 'failed')

    const history = createResultsCache(defaultCacheDir(p.dir))
    assert.equal(history.get('rt', 'small-fails.test.js')?.failed, true)
    assert.equal(history.get('rt', 'small-fails.test.js')?.tests, 1)
    assert.equal(history.get('rt', 'big.test.js')?.failed, false)
    assert.equal(history.get('rt', 'big.test.js')?.tests, 2)

    const second = await run(project, {
      defaultCache: true,
      pool: { kind: 'inline', maxWorkers: 1 },
    })
    const order = queuedOrder(second.seen)
    assert.equal(order[0], 'small-fails.test.js', 'the failed file runs first')
    assert.equal(order.length, 3)
  })

  it('runs and records nothing in the cache when it is off', async () => {
    const p = await makeProject({ 'a.test.js': passing() })
    await run(runtimeProject(p.dir), { cache: false, pool: { kind: 'inline', maxWorkers: 1 } })
    assert.equal(createResultsCache(defaultCacheDir(p.dir)).get('rt', 'a.test.js'), undefined)
  })

  it('hands -t to the workers: other tests are skipped', async () => {
    const p = await makeProject({
      'a.test.js': [
        "test('alpha one', () => {})",
        "test('beta two', () => { throw new Error('should not run') })",
      ].join('\n'),
    })
    const { summary, seen } = await run(runtimeProject(p.dir), {
      testNamePattern: 'alpha',
      pool: { kind: 'inline', maxWorkers: 1 },
    })
    const states = seen
      .filter((entry) => entry.name === 'task:end' && entry.detail.type === 'test')
      .map((entry) => [entry.detail.name, entry.detail.state])
    assert.deepEqual(states, [
      ['alpha one', 'pass'],
      ['beta two', 'skip'],
    ])
    assert.equal(summary.reason, 'passed')
  })

  it('rejects an invalid test name pattern before anything starts', async () => {
    const p = await makeProject({ 'a.test.js': passing() })
    const { reporter, seen } = recorder()
    await assert.rejects(
      runProject(runtimeProject(p.dir), {
        bus: createReporterBus([reporter]),
        cache: false,
        entry: PID_RECORDING_ENTRY,
        stderr: new Collect(),
        testNamePattern: '(unclosed',
        pool: { kind: 'forks', maxWorkers: 2 },
      }),
      { code: 'ORCH_BAD_PATTERN', message: /\(unclosed/ },
    )
    assert.deepEqual(seen, [], 'not even run:start')
    assert.deepEqual(await takeWorkerPids(), [], 'no worker was spawned')
  })

  it('finds no files: run:start and run:end only, and the no-tests exit code', async () => {
    const p = await makeProject({ 'readme.md': 'no tests here' })
    const project = runtimeProject(p.dir)
    const { summary, seen, pids } = await run(project, { pool: { kind: 'forks' } })
    assert.deepEqual(
      seen.map((entry) => entry.name),
      ['run:start', 'run:end'],
    )
    assert.deepEqual(summary.files, [])
    assert.equal(summary.reason, 'passed')
    assert.deepEqual(pids, [])
    assert.equal(
      exitCodeFor(summary, { policy: project.policy }),
      project.policy.orchestrator.exitCodes.noTests,
    )
    assert.equal(exitCodeFor(summary, { policy: project.policy, passWithNoTests: true }), 0)
  })

  it('fails the file, not the run, for a collection error, and reports its errors', async () => {
    const p = await makeProject({
      'bad.test.js': "throw new Error('cannot collect')",
      'good.test.js': passing(),
    })
    const { summary } = await run(runtimeProject(p.dir), {
      pool: { kind: 'inline', maxWorkers: 1 },
    })
    const byPath = new Map(summary.files.map((f) => [f.file.path, f]))
    assert.equal(byPath.get('good.test.js')?.state, 'pass')
    assert.equal(byPath.get('bad.test.js')?.state, 'fail')
    assert.match(byPath.get('bad.test.js')?.errors[0]?.message ?? '', /cannot collect/)
    assert.equal(summary.reason, 'failed')
  })

  it('records the run in the cache it is given, replacing the old history', async () => {
    const p = await makeProject({ 'a.test.js': passing() })
    const cache = createResultsCache(join(p.dir, 'cache'))
    cache.record('rt', 'a.test.js', { durationMs: 12, failed: false, tests: 2, at: 0 })
    const { summary } = await run(runtimeProject(p.dir), {
      cache,
      pool: { kind: 'inline', maxWorkers: 1 },
    })
    assert.equal(summary.reason, 'passed')
    await cache.write()
    // The file ran, so the cache holds this run's duration and test count.
    const history = createResultsCache(join(p.dir, 'cache')).get('rt', 'a.test.js')
    assert.notEqual(history?.durationMs, 12)
    assert.equal(history?.tests, 2)
    assert.equal(history?.failed, false)
  })
})
