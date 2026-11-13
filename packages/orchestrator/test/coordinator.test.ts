// `runProject` end to end: real projects on disk, the fixtures' environment and globals, and real
// forked workers where it matters (a worker killed by a signal, every worker gone afterwards).
// The Jest dialect with the real node environment runs this through `provino/node` in B11's bench
// check; here the orchestrator may not depend on either, so the fixtures stand in.
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  createResultsCache,
  defaultCacheDir,
  defaultWorkerMemoryLimit,
  ExitCode,
  exitCodeFor,
  fileIdOf,
  projectCacheKey,
  runProject,
} from '@provino/orchestrator'
import { createReporterBus } from '@provino/reporters'
import type { Reporter, ReporterBus, TaskId } from '@provino/types'
import {
  assertWorkersGone,
  Collect,
  fixture,
  PID_RECORDING_ENTRY,
  recorder,
  run,
  runtimeProject,
  type Seen,
  takeWorkerPids,
  trackedProjects,
} from './support.ts'

const makeProject = trackedProjects()

/** The names of the events of one file, in order. */
const namesOf = (seen: readonly Seen[], fileId: TaskId): string[] =>
  seen.filter((entry) => entry.fileId === fileId).map((entry) => entry.name)

/**
 * The pairing every file keeps: a `file:start` is followed by exactly one `file:end`, and a
 * `file:end` never comes without its `file:start` (and never before it).
 */
function assertStartEndPaired(seen: readonly Seen[]): void {
  const ids = new Set(seen.flatMap((entry) => (entry.fileId === null ? [] : [entry.fileId])))
  for (const id of ids) {
    const names = namesOf(seen, id).filter((name) => name === 'file:start' || name === 'file:end')
    assert.ok(
      names.length === 0 || (names.length === 2 && names[0] === 'file:start'),
      `${id}: ${names.join(', ') || 'neither'}`,
    )
  }
}

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
      assertStartEndPaired(seen)

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

  it('stops the run and kills the workers when the signal aborts: the file that had started ends as a failure, the rest are not reported', async () => {
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
    assert.equal(exitCodeFor(summary, { policy: runtimeProject(p.dir).policy }), ExitCode.Sigint)

    // The file that had started is reported: it was cut off, so it failed, and says why.
    assert.deepEqual(
      summary.files.map((f) => [f.file.path, f.state]),
      [['a-hangs.test.js', 'fail']],
    )
    const [cut] = summary.files
    assert.equal(cut?.errors.length, 1)
    assert.match(cut?.errors[0]?.message ?? '', /interrupted/i)
    assert.match(cut?.errors[0]?.message ?? '', /a-hangs\.test\.js/)
    const ends = seen.filter((entry) => entry.name === 'file:end')
    assert.deepEqual(
      ends.map((entry) => [entry.fileId, entry.detail.state]),
      [[cut?.file.fileId, 'fail']],
    )

    // The files that never started have neither `file:start` nor `file:end`, and are not in the summary.
    assert.equal(seen.filter((entry) => entry.name === 'file:start').length, 1)
    assertStartEndPaired(seen)
    for (const path of ['b.test.js', 'c.test.js']) {
      const id = fileIdOf('rt', path)
      assert.deepEqual(namesOf(seen, id), ['file:queued'], path)
    }
    // `file:end` comes before `run:end`, which closes the run.
    const names = seen.map((entry) => entry.name)
    assert.ok(names.lastIndexOf('file:end') < names.indexOf('run:end'))
    assert.equal(seen.at(-1)?.name, 'run:end')
    assert.equal(seen.at(-1)?.detail.reason, 'interrupted')
    assert.equal(pids.length, 1)
    assertWorkersGone(pids)
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
    assert.equal(seen.filter((entry) => entry.name === 'file:end').length, 5)
    assert.ok(stderr.text.length > 0, 'the worker’s own error reached the stderr sink')

    // A file that fails without a worker still has `file:start` before its `file:end`, with the
    // worker whose failed start it reports: its own (1, 2, 3), then the last one for the files
    // left when the pool gave up.
    assertStartEndPaired(seen)
    assert.equal(seen.filter((entry) => entry.name === 'file:start').length, 5)
    const startedOn = summary.files.map(
      (f) =>
        seen.find((entry) => entry.name === 'file:start' && entry.fileId === f.file.fileId)?.detail
          .workerId,
    )
    assert.deepEqual(startedOn, [1, 2, 3, 3, 3])
    for (const { file } of summary.files) {
      assert.deepEqual(namesOf(seen, file.fileId), ['file:queued', 'file:start', 'file:end'])
    }
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
    assert.equal(
      history.get(projectCacheKey(runtimeProject(p.dir)), 'small-fails.test.js')?.failed,
      true,
    )
    assert.equal(
      history.get(projectCacheKey(runtimeProject(p.dir)), 'small-fails.test.js')?.tests,
      1,
    )
    assert.equal(history.get(projectCacheKey(runtimeProject(p.dir)), 'big.test.js')?.failed, false)
    assert.equal(history.get(projectCacheKey(runtimeProject(p.dir)), 'big.test.js')?.tests, 2)

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
    assert.equal(
      createResultsCache(defaultCacheDir(p.dir)).get(
        projectCacheKey(runtimeProject(p.dir)),
        'a.test.js',
      ),
      undefined,
    )
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

  it('reports nothing for any file when the signal is already aborted: no file:start, no file:end, an interrupted run', async () => {
    const p = await makeProject({ 'a.test.js': passing('a'), 'b.test.js': passing('b') })
    const { summary, seen } = await run(runtimeProject(p.dir), {
      pool: { kind: 'inline', maxWorkers: 1 },
      signal: AbortSignal.abort(),
    })
    assert.equal(summary.reason, 'interrupted')
    assert.deepEqual(summary.files, [])
    assert.deepEqual(
      seen.map((entry) => entry.name),
      ['run:start', 'file:queued', 'file:queued', 'run:end'],
    )
  })

  it('rejects a bad recycle, deadline or bail option before run:start: reporters never see a run that cannot happen', async () => {
    const p = await makeProject({ 'a.test.js': passing() })
    const bad: readonly Partial<Parameters<typeof runProject>[1]>[] = [
      { pool: { kind: 'inline', recycle: { maxFilesPerWorker: 0 } } },
      { pool: { kind: 'inline', recycle: { memoryLimitBytes: -1 } } },
      { pool: { kind: 'inline', fileTimeoutMs: 0 } },
      { bail: { count: 0 } },
      { bail: { count: 1.5 } },
    ]
    for (const extra of bad) {
      const { reporter, seen } = recorder()
      await assert.rejects(
        runProject(runtimeProject(p.dir), {
          bus: createReporterBus([reporter]),
          cache: false,
          stderr: new Collect(),
          pool: { kind: 'inline' },
          ...extra,
        }),
        { code: 'ORCH_BAD_OPTION' },
      )
      assert.deepEqual(seen, [], 'not even run:start')
    }
  })

  it('closes the pool, tells the bus and ends the run with run:end when something throws after run:start', async () => {
    const p = await makeProject({
      'a.test.js': passing('a'),
      'b.test.js': passing('b'),
      'c.test.js': passing('c'),
    })
    const { reporter, seen } = recorder()
    const inner = createReporterBus([reporter])
    // A bus that breaks once the first file has run: `file:end` rejects.
    const broken: ReporterBus = {
      add: (added) => inner.add(added),
      emit: (event, ...args) =>
        event === 'file:end'
          ? Promise.reject(new Error('the bus broke'))
          : inner.emit(event, ...args),
    }
    await assert.rejects(
      runProject(runtimeProject(p.dir), {
        bus: broken,
        cache: false,
        stderr: new Collect(),
        entry: PID_RECORDING_ENTRY,
        pool: { kind: 'forks', maxWorkers: 2 },
      }),
      { message: 'the bus broke' },
    )
    const pids = await takeWorkerPids()
    assert.ok(pids.length > 0)
    assertWorkersGone(pids)

    // `run:start` was emitted, so the run is closed: the error, then `run:end` as failed.
    assert.equal(seen[0]?.name, 'run:start')
    assert.deepEqual(
      seen.slice(-2).map((entry) => [entry.name, entry.detail.message ?? entry.detail.reason]),
      [
        ['error', 'the bus broke'],
        ['run:end', 'failed'],
      ],
    )
    assert.equal(seen.at(-2)?.detail.origin, 'coordinator')
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

  it('drops the history of a file that is no longer discovered, and keeps the files that are', async () => {
    const p = await makeProject({ 'a.test.js': passing('a'), 'b.test.js': passing('b') })
    const dir = join(p.dir, 'cache')
    const inline = { kind: 'inline', maxWorkers: 1 } as const
    await run(runtimeProject(p.dir), { cache: createResultsCache(dir), pool: inline })
    const first = createResultsCache(dir)
    assert.notEqual(first.get(projectCacheKey(runtimeProject(p.dir)), 'a.test.js'), undefined)
    assert.notEqual(first.get(projectCacheKey(runtimeProject(p.dir)), 'b.test.js'), undefined)

    await rm(p.path('b.test.js'))
    await run(runtimeProject(p.dir), { cache: createResultsCache(dir), pool: inline })
    const second = createResultsCache(dir)
    assert.notEqual(second.get(projectCacheKey(runtimeProject(p.dir)), 'a.test.js'), undefined)
    assert.equal(
      second.get(projectCacheKey(runtimeProject(p.dir)), 'b.test.js'),
      undefined,
      'a deleted file has no history',
    )
  })

  it('keeps what another run wrote to the cache while this one was running', async () => {
    const p = await makeProject({ 'a.test.js': passing('a') })
    const dir = join(p.dir, 'cache')
    const inline = { kind: 'inline', maxWorkers: 1 } as const
    // This run's cache is opened first; then another project’s run writes the file.
    const early = createResultsCache(dir)
    await run(runtimeProject(p.dir, { name: 'other' }), {
      cache: createResultsCache(dir),
      pool: inline,
    })
    await run(runtimeProject(p.dir), { cache: early, pool: inline })
    const merged = createResultsCache(dir)
    assert.notEqual(
      merged.get(projectCacheKey(runtimeProject(p.dir, { name: 'other' })), 'a.test.js'),
      undefined,
      'the other run’s history survives',
    )
    assert.notEqual(merged.get(projectCacheKey(runtimeProject(p.dir)), 'a.test.js'), undefined)
  })

  it('records the run in the cache it is given, replacing the old history', async () => {
    const p = await makeProject({ 'a.test.js': passing() })
    const cache = createResultsCache(join(p.dir, 'cache'))
    cache.record(projectCacheKey(runtimeProject(p.dir)), 'a.test.js', {
      durationMs: 12,
      failed: false,
      tests: 2,
      at: 0,
    })
    const { summary } = await run(runtimeProject(p.dir), {
      cache,
      pool: { kind: 'inline', maxWorkers: 1 },
    })
    assert.equal(summary.reason, 'passed')
    await cache.write()
    // The file ran, so the cache holds this run's duration and test count.
    const history = createResultsCache(join(p.dir, 'cache')).get(
      projectCacheKey(runtimeProject(p.dir)),
      'a.test.js',
    )
    assert.notEqual(history?.durationMs, 12)
    assert.equal(history?.tests, 2)
    assert.equal(history?.failed, false)
  })
})

describe('runProject over an inline worker that holds more memory than the limit', () => {
  it('keeps the worker: its memory is the coordinator’s own, and a replacement would free none of it', async () => {
    // What a CI runner does by default: a limit under the heap the test process already holds.
    const p = await makeProject({
      'a.test.js': passing('a'),
      'b.test.js': passing('b'),
      'c.test.js': passing('c'),
    })
    const { summary, seen } = await run(runtimeProject(p.dir), {
      pool: { kind: 'inline', maxWorkers: 1, recycle: { memoryLimitBytes: 1 } },
    })
    assert.deepEqual(
      summary.files.map((file) => file.state),
      ['pass', 'pass', 'pass'],
    )
    const workers = seen
      .filter((entry) => entry.name === 'file:start')
      .map((entry) => entry.detail.workerId)
    assert.deepEqual(workers, [1, 1, 1], 'one inline worker took every file')
  })
})

describe('runProject over real threads under the default memory limit', () => {
  it('reuses a healthy worker for every file: a thread is measured by its own heap, not by the process-wide `external`', async () => {
    // A thread's `process.memoryUsage().external` counts ArrayBuffers the whole run reserves (oxc's
    // raw transfer buffer alone is about 6 GiB), so `heapUsed + external` put every thread over
    // the default limit, and every file got a fresh thread. jest-worker reads `heapUsed`.
    const p = await makeProject({
      'a.test.js': passing('a'),
      'b.test.js': passing('b'),
      'c.test.js': passing('c'),
      'd.test.js': passing('d'),
    })
    // The default is a quarter of the memory over the workers, never under 512 MiB. A container
    // with 1 GiB to give is that floor however many workers there are, on any machine.
    const project = runtimeProject(p.dir)
    const original = process.constrainedMemory
    process.constrainedMemory = () => 1024 * 1024 * 1024
    let result: Awaited<ReturnType<typeof run>>
    try {
      assert.equal(defaultWorkerMemoryLimit(1), 512 * 1024 * 1024, 'the default is the floor')
      result = await run(project, { pool: { kind: 'threads', maxWorkers: 1 } })
    } finally {
      process.constrainedMemory = original
    }
    const { summary, seen } = result
    assert.deepEqual(
      summary.files.map((file) => file.state),
      ['pass', 'pass', 'pass', 'pass'],
    )
    const workers = seen
      .filter((entry) => entry.name === 'file:start')
      .map((entry) => entry.detail.workerId)
    assert.equal(workers.length, 4)
    assert.equal(new Set(workers).size, 1, `one thread took every file, got ${workers.join(', ')}`)
  })
})

describe('runProject: pool and run lifecycle', () => {
  it('runs an inline pool on one worker whatever maxWorkers says: three passing files all pass', async () => {
    const p = await makeProject({
      'a.test.js': passing('a'),
      'b.test.js': passing('b'),
      'c.test.js': passing('c'),
    })
    const { summary, seen } = await run(runtimeProject(p.dir), {
      pool: { kind: 'inline', maxWorkers: 4 },
    })
    assert.deepEqual(
      summary.files.map((file) => file.state),
      ['pass', 'pass', 'pass'],
    )
    assert.equal(summary.reason, 'passed')
    assert.deepEqual(summary.unhandled, [])
    const workers = seen
      .filter((entry) => entry.name === 'file:start')
      .map((e) => e.detail.workerId)
    assert.equal(new Set(workers).size, 1, 'one inline worker took every file')
  })

  it('keeps the history of two unnamed projects in one root, run in turn', async () => {
    const p = await makeProject({ 'a1.test.js': passing('a'), 'b1.test.js': passing('b') })
    const dir = join(p.dir, 'cache')
    const inline = { kind: 'inline', maxWorkers: 1 } as const
    const onlyA = runtimeProject(p.dir, { name: '', include: ['a*.test.js'] })
    const onlyB = runtimeProject(p.dir, { name: '', include: ['b*.test.js'] })
    for (const project of [onlyA, onlyB, onlyA, onlyB]) {
      await run(project, { cache: createResultsCache(dir), pool: inline })
    }
    const cache = createResultsCache(dir)
    assert.notEqual(cache.get(projectCacheKey(onlyA), 'a1.test.js'), undefined)
    assert.notEqual(cache.get(projectCacheKey(onlyB), 'b1.test.js'), undefined)
    assert.notEqual(projectCacheKey(onlyA), projectCacheKey(onlyB))
  })

  it('sends a fork’s direct stdout writes to the stdout sink, not the process’s', async () => {
    const p = await makeProject({
      'raw.test.js': [
        "import { writeSync } from 'node:fs'",
        "test('writes to fd 1', () => { writeSync(1, 'RAW\\n') })",
      ].join('\n'),
    })
    const stdout = new Collect()
    const { summary } = await run(runtimeProject(p.dir), {
      pool: { kind: 'forks', maxWorkers: 1 },
      stdout,
    })
    assert.equal(summary.reason, 'passed')
    assert.match(stdout.text, /RAW/)
  })

  it('ends promptly when the signal aborts while a worker is still starting', async () => {
    const p = await makeProject({ 'a.test.js': passing() })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)
    const started = performance.now()
    const stderr = new Collect()
    const summary = await runProject(runtimeProject(p.dir), {
      bus: createReporterBus([]),
      cache: false,
      stderr,
      entry: fixture('silent-worker.ts').href,
      pool: { kind: 'forks', maxWorkers: 1, startTimeoutMs: 8000 },
      signal: controller.signal,
    })
    assert.equal(summary.reason, 'interrupted')
    assert.ok(performance.now() - started < 4000, 'did not wait for the start timeout')
  })

  it('shows what a worker sends when it stops after its last file’s file:end, though it stops while other files run', async () => {
    // Under `none` the environment's leak report comes at stop, as a console warning. Workers are
    // stopped as soon as no file is left to wait for, which can be before that file's `file:end`.
    const p = await makeProject({ 'a.test.js': passing('aaaa'), 'b.test.js': passing() })
    const project = {
      ...runtimeProject(p.dir, { environmentOptions: { leak: '__stuck' } }),
      isolation: 'none' as const,
    }
    const { summary, seen } = await run(project, { pool: { kind: 'forks', maxWorkers: 2 } })
    assert.equal(summary.reason, 'passed')
    const warnings = seen.flatMap((entry, index) =>
      entry.name === 'console' && String(entry.detail.text).includes('when the worker stopped')
        ? [{ index, fileId: entry.fileId }]
        : [],
    )
    assert.equal(warnings.length, 2, 'one warning per worker')
    for (const { index, fileId } of warnings) {
      const ended = seen.findIndex((entry) => entry.name === 'file:end' && entry.fileId === fileId)
      assert.ok(ended >= 0 && ended < index, 'under the file it ran last, after its file:end')
    }
  })

  it('reports a worker that crashes when told to stop, and does not pass the run', {
    skip: process.platform === 'win32',
  }, async () => {
    const p = await makeProject({ 'a.test.js': passing() })
    const { summary, seen } = await run(runtimeProject(p.dir), {
      pool: { kind: 'forks', maxWorkers: 1 },
      entry: fixture('crash-on-stop-main.ts'),
    })
    const errors = seen.filter((entry) => entry.name === 'error')
    assert.equal(errors.length, 1)
    assert.match(String(errors[0]?.detail.message), /exited while it ran no file/)
    assert.equal(errors[0]?.detail.origin, 'coordinator')
    assert.equal(summary.unhandled.length, 1)
    assert.equal(summary.reason, 'failed')
  })
})
