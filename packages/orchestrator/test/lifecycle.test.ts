// T9.10 in the coordinator: `bail` (when it is checked, what it kills, what it reports), the run
// reasons a signal gives (`interrupted` 130, `terminated` 143), a second Ctrl+C (`forceSignal`), and
// `detectOpenHandles`. Real forked workers, with the pids checked afterwards; the bin's side of
// the same is `packages/provino/test/lifecycle.test.ts`.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { ResolvedProject } from '@provino/config'
import {
  ExitCode,
  exitCodeFor,
  type ResultsCache,
  type RunProjectOptions,
  runProject,
} from '@provino/orchestrator'
import { createReporterBus } from '@provino/reporters'
import type { Reporter, RunSummary } from '@provino/types'
import {
  Collect,
  fixture,
  isRunning,
  PID_RECORDING_ENTRY,
  runtimeProject,
  takeWorkerPids,
  trackedProjects,
} from './support.ts'

const makeProject = trackedProjects()

interface Seen {
  readonly name: string
  readonly path: string
}

interface Run {
  readonly summary: RunSummary
  readonly seen: readonly Seen[]
  readonly project: ResolvedProject
  readonly elapsedMs: number
}

const pad = (bytes: number): string => `// ${'x'.repeat(bytes)}\n`
const failing = (count: number): string =>
  Array.from({ length: count }, (_, i) => `test('fails ${i}', () => { expect(1).toBe(2) })`).join(
    '\n',
  )
const passing = (extra = ''): string => `${extra}test('passes', () => { expect(1).toBe(1) })\n`
const hanging = "test('hangs', () => { for (;;) {} })\n"

/** What happened to files, by path, in the order the bus heard it. */
function recorder(): { reporter: Reporter; seen: Seen[] } {
  const seen: Seen[] = []
  const reporter: Reporter = {
    name: 'recorder',
    'file:start': (file) => void seen.push({ name: 'file:start', path: file.path }),
    'file:end': (result) => void seen.push({ name: 'file:end', path: result.file.path }),
  }
  return { reporter, seen }
}

const eventsOf = (seen: readonly Seen[], path: string): string[] =>
  seen.filter((entry) => entry.path === path).map((entry) => entry.name)

/** Every worker the entries that note their pid started is gone, and the notes are removed. */
async function assertNoWorkerLeft(): Promise<void> {
  const pids = await takeWorkerPids()
  assert.ok(pids.length > 0, 'the run started a worker, so there is a pid to check')
  for (const pid of pids) assert.equal(isRunning(pid), false, `worker ${pid} is still running`)
}

/** Runs the project's files over forks, and checks that no worker outlived the run. */
async function run(
  files: Readonly<Record<string, string>>,
  options: {
    readonly checkAfter?: 'file' | 'test'
    readonly maxWorkers?: number
  } & Partial<RunProjectOptions> = {},
): Promise<Run> {
  const { checkAfter, maxWorkers, pool, ...rest } = options
  const made = await makeProject(files)
  const project = runtimeProject(made.dir, {
    ...(checkAfter === undefined ? {} : { policy: { orchestrator: { bail: { checkAfter } } } }),
  })
  const { reporter, seen } = recorder()
  const started = performance.now()
  const summary = await runProject(project, {
    bus: createReporterBus([reporter]),
    cache: false,
    stderr: new Collect(),
    entry: PID_RECORDING_ENTRY,
    pool: { kind: 'forks', maxWorkers: maxWorkers ?? 1, ...pool },
    ...rest,
  })
  const elapsedMs = performance.now() - started
  for (const pid of await takeWorkerPids()) assert.equal(isRunning(pid), false, `worker ${pid}`)
  return { summary, seen, project, elapsedMs }
}

describe('bail, checked after each file (Jest)', () => {
  it('ends the run after the first file that fails, reports it, and starts no other', async () => {
    const { summary, seen, project } = await run(
      {
        'a.test.js': `${pad(300)}${failing(1)}\ntest('passes', () => {})\n`,
        'b.test.js': passing(pad(100)),
        'c.test.js': passing(),
      },
      { checkAfter: 'file', bail: { count: 1 } },
    )
    assert.deepEqual(
      summary.files.map((file) => [file.file.path, file.state]),
      [['a.test.js', 'fail']],
    )
    assert.deepEqual(eventsOf(seen, 'a.test.js'), ['file:start', 'file:end'])
    assert.deepEqual(eventsOf(seen, 'b.test.js'), [], 'never started')
    assert.deepEqual(eventsOf(seen, 'c.test.js'), [], 'never started')
    assert.equal(summary.reason, 'failed', 'a bail is a failed run, not an interruption')
    assert.equal(exitCodeFor(summary, { policy: project.policy }), 1)
  })

  it('counts failed tests across files: two failures in two files, then the third file is never run', async () => {
    const { summary, seen } = await run(
      {
        'a.test.js': `${pad(300)}${failing(1)}\n`,
        'b.test.js': `${pad(200)}${failing(1)}\n`,
        'c.test.js': passing(),
      },
      { checkAfter: 'file', bail: { count: 2 } },
    )
    assert.deepEqual(
      summary.files.map((file) => file.file.path),
      ['a.test.js', 'b.test.js'],
    )
    assert.deepEqual(eventsOf(seen, 'c.test.js'), [])
    assert.equal(summary.reason, 'failed')
  })

  it('counts tests, not files: one file with three failing tests reaches a count of 3', async () => {
    const { summary } = await run(
      { 'a.test.js': `${pad(300)}${failing(3)}\n`, 'b.test.js': passing() },
      { checkAfter: 'file', bail: { count: 3 } },
    )
    assert.deepEqual(
      summary.files.map((file) => file.file.path),
      ['a.test.js'],
    )
  })

  it('does not end a run whose failures stay under the count', async () => {
    const { summary } = await run(
      { 'a.test.js': `${pad(300)}${failing(1)}\n`, 'b.test.js': passing(), 'c.test.js': passing() },
      { checkAfter: 'file', bail: { count: 2 } },
    )
    assert.equal(summary.files.length, 3)
    assert.equal(summary.reason, 'failed')
  })

  it('kills the files still running, reports them no further, and is quick about it', async () => {
    // Which worker takes which file, and how soon, is the machine's to say. So the file that
    // fails waits for a marker that the file that hangs writes once it is running: `file:start`
    // of the one is on the bus before the other can fail, whatever the load.
    const marker = join(tmpdir(), `provino-bail-b-started-${process.pid}-${randomUUID()}`)
    const waitsForB = [
      "test('fails once b is running', () => {",
      "  const { existsSync } = require('node:fs')",
      '  const sleep = new Int32Array(new SharedArrayBuffer(4))',
      '  const until = Date.now() + 30000',
      `  while (!existsSync(${JSON.stringify(marker)})) {`,
      "    if (Date.now() > until) throw new Error('b never started')",
      '    Atomics.wait(sleep, 0, 0, 10)',
      '  }',
      '  expect(1).toBe(2)',
      '})',
      '',
    ].join('\n')
    const hangsOnceRunning = [
      "test('hangs', () => {",
      `  require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
      '  for (;;) {}',
      '})',
      '',
    ].join('\n')
    const { summary, seen, elapsedMs } = await run(
      { 'a-fails.test.js': waitsForB, 'b-hangs.test.js': hangsOnceRunning },
      { checkAfter: 'file', bail: { count: 1 }, maxWorkers: 2 },
    ).finally(() => rm(marker, { force: true }))
    assert.deepEqual(
      summary.files.map((file) => file.file.path),
      ['a-fails.test.js'],
      'only the file that finished is in the summary',
    )
    // The one exception to every `file:start` having a `file:end`: Jest reports a killed file no
    // further.
    assert.deepEqual(eventsOf(seen, 'b-hangs.test.js'), ['file:start'])
    assert.deepEqual(eventsOf(seen, 'a-fails.test.js'), ['file:start', 'file:end'])
    assert.equal(summary.reason, 'failed')
    assert.ok(elapsedMs < 20_000, `the killed worker did not hold the run up (${elapsedMs} ms)`)
  })

  it('a bail that no file reaches changes nothing', async () => {
    const { summary } = await run(
      { 'a.test.js': passing(), 'b.test.js': passing() },
      { checkAfter: 'file', bail: { count: 1 } },
    )
    assert.equal(summary.reason, 'passed')
    assert.equal(summary.files.length, 2)
  })
})

describe('bail, checked after each test (Vitest)', () => {
  it('starts no file after the count is reached, and lets the running one end, reported whole', async () => {
    const { summary, seen } = await run(
      {
        'a.test.js': `${pad(300)}${failing(3)}\n`,
        'b.test.js': passing(pad(100)),
        'c.test.js': passing(),
      },
      { checkAfter: 'test', bail: { count: 2 } },
    )
    assert.deepEqual(
      summary.files.map((file) => [file.file.path, file.state]),
      [['a.test.js', 'fail']],
    )
    assert.deepEqual(eventsOf(seen, 'a.test.js'), ['file:start', 'file:end'])
    assert.deepEqual(eventsOf(seen, 'b.test.js'), [])
    assert.deepEqual(eventsOf(seen, 'c.test.js'), [])
    assert.equal(summary.reason, 'failed')
  })
})

describe('bail options', () => {
  it('refuses a count that is not a whole number of at least 1, before anything runs', async () => {
    for (const count of [0, -1, 1.5, Number.NaN]) {
      await assert.rejects(run({ 'a.test.js': passing() }, { bail: { count } }), {
        code: 'ORCH_BAD_OPTION',
      })
    }
  })
})

describe('signals', () => {
  it('SIGINT (an abort with no reason) is `interrupted`, exit code 130', async () => {
    const controller = new AbortController()
    const { reporter, seen } = recorder()
    const made = await makeProject({ 'a.test.js': hanging })
    const project = runtimeProject(made.dir)
    const running = runProject(project, {
      bus: createReporterBus([
        reporter,
        { name: 'abort', 'file:start': () => void setTimeout(() => controller.abort(), 100) },
      ]),
      cache: false,
      stderr: new Collect(),
      entry: PID_RECORDING_ENTRY,
      pool: { kind: 'forks', maxWorkers: 1 },
      signal: controller.signal,
    })
    const summary = await running
    assert.equal(summary.reason, 'interrupted')
    assert.equal(exitCodeFor(summary, { policy: project.policy }), ExitCode.Sigint)
    assert.equal(exitCodeFor(summary, { policy: project.policy }), 130)
    assert.deepEqual(eventsOf(seen, 'a.test.js'), ['file:start', 'file:end'])
    // The worker was in a synchronous loop: only the kill got rid of it.
    await assertNoWorkerLeft()
  })

  it('SIGTERM (an abort with the reason "SIGTERM") is `terminated`, exit code 143', async () => {
    const controller = new AbortController()
    const made = await makeProject({ 'a.test.js': hanging })
    const project = runtimeProject(made.dir)
    const summary = await runProject(project, {
      bus: createReporterBus([
        {
          name: 'abort',
          'file:start': () => void setTimeout(() => controller.abort('SIGTERM'), 100),
        },
      ]),
      cache: false,
      stderr: new Collect(),
      entry: PID_RECORDING_ENTRY,
      pool: { kind: 'forks', maxWorkers: 1 },
      signal: controller.signal,
    })
    assert.equal(summary.reason, 'terminated')
    assert.equal(exitCodeFor(summary, { policy: project.policy }), ExitCode.Sigterm)
    assert.equal(exitCodeFor(summary, { policy: project.policy }), 143)
    assert.deepEqual(
      summary.files.map((file) => [file.file.path, file.state]),
      [['a.test.js', 'fail']],
      'the file that was running is the interrupted one, as under SIGINT',
    )
    await assertNoWorkerLeft()
  })

  it('an already aborted SIGTERM signal ends a run that finds files as `terminated` too', async () => {
    const made = await makeProject({})
    const project = runtimeProject(made.dir)
    const summary = await runProject(project, {
      bus: createReporterBus([]),
      cache: false,
      stderr: new Collect(),
      pool: { kind: 'forks', maxWorkers: 1 },
      signal: AbortSignal.abort('SIGTERM'),
    })
    assert.equal(summary.reason, 'terminated')
  })

  it('a signal that comes after every file has ended, while the run winds down, still ends it interrupted or terminated', async () => {
    for (const [reason, expected, code] of [
      [undefined, 'interrupted', ExitCode.Sigint],
      ['SIGTERM', 'terminated', ExitCode.Sigterm],
    ] as const) {
      const controller = new AbortController()
      const made = await makeProject({ 'a.test.js': passing() })
      const project = runtimeProject(made.dir)
      // The results cache is written once the last file is done: the signal lands in that window.
      const cache: ResultsCache = {
        get: () => undefined,
        record: () => {},
        prune: () => {},
        write: async () => controller.abort(reason),
      }
      const summary = await runProject(project, {
        bus: createReporterBus([]),
        cache,
        stderr: new Collect(),
        entry: PID_RECORDING_ENTRY,
        pool: { kind: 'forks', maxWorkers: 1 },
        signal: controller.signal,
      })
      assert.equal(summary.reason, expected)
      assert.deepEqual(
        summary.files.map((file) => file.state),
        ['pass'],
        'the file had finished: the interruption cost it nothing',
      )
      assert.equal(exitCodeFor(summary, { policy: project.policy }), code)
      await assertNoWorkerLeft()
    }
  })

  it('a force signal ends the run without waiting for a worker that will not stop', async () => {
    const controller = new AbortController()
    const force = new AbortController()
    const made = await makeProject({ 'a.test.js': passing() })
    const project = runtimeProject(made.dir)
    const started = performance.now()
    const summary = await runProject(project, {
      bus: createReporterBus([
        {
          name: 'second ctrl+c',
          // The file is done: the worker is being stopped, and cannot be. The first Ctrl+C aborts
          // the run; the second kills.
          'file:end': () =>
            void setTimeout(() => {
              controller.abort()
              setTimeout(() => force.abort(), 100)
            }, 100),
        },
      ]),
      cache: false,
      stderr: new Collect(),
      entry: fixture('stuck-stop-worker.ts'),
      pool: { kind: 'forks', maxWorkers: 1, teardownTimeoutMs: 120_000 },
      signal: controller.signal,
      forceSignal: force.signal,
    })
    assert.ok(performance.now() - started < 10_000, 'it did not wait out the 120 s teardown')
    assert.ok(summary.files.length <= 1)
    // The worker ignores SIGTERM and its stop never ends: only the force signal's SIGKILL ended it.
    await assertNoWorkerLeft()
  })
})

describe('detectOpenHandles', () => {
  // A harmless leak: an interval that ends itself after 400 ms, so the test process can exit.
  const leak = [
    '// a test that leaves an interval running',
    "test('leaks an interval', () => {",
    '  let ticks = 0',
    '  const timer = setInterval(() => { if (++ticks > 16) clearInterval(timer) }, 25)',
    '})',
    '',
  ].join('\n')

  it('runs in band whatever the pool says, and reports the handle and the line that made it', async () => {
    const made = await makeProject({ 'leak.test.js': leak, 'clean.test.js': passing() })
    const project = runtimeProject(made.dir)
    const summary = await runProject(project, {
      bus: createReporterBus([]),
      cache: false,
      stderr: new Collect(),
      pool: { kind: 'forks', maxWorkers: 4 },
      detectOpenHandles: true,
    })
    assert.equal(summary.reason, 'passed')
    const handles = summary.openHandles ?? []
    assert.equal(handles.length, 1, JSON.stringify(handles))
    const [handle] = handles
    assert.equal(handle?.type, 'Timeout')
    assert.match(handle?.frames[0] ?? '', /leak\.test\.js:4:17/, handle?.frames.join('\n'))
    assert.match(handle?.codeFrame ?? '', />\s*4 \| {3}const timer = setInterval/)
    assert.match(handle?.codeFrame ?? '', /\^/)
    // Let the interval end itself, so the test process is not held open.
    await new Promise((resolve) => setTimeout(resolve, 600))
  })

  it('reports nothing when every handle was closed, or is unref’d', async () => {
    const made = await makeProject({
      'clean.test.js': [
        "test('cleans up', () => {",
        '  const timer = setInterval(() => {}, 25)',
        '  clearInterval(timer)',
        '  setInterval(() => {}, 25).unref()',
        '})',
        '',
      ].join('\n'),
    })
    const summary = await runProject(runtimeProject(made.dir), {
      bus: createReporterBus([]),
      cache: false,
      stderr: new Collect(),
      detectOpenHandles: true,
    })
    assert.equal(summary.openHandles, undefined)
  })

  it('is off by default: no hook is installed, and no handle is reported', async () => {
    const made = await makeProject({ 'leak.test.js': leak })
    const summary = await runProject(runtimeProject(made.dir), {
      bus: createReporterBus([]),
      cache: false,
      stderr: new Collect(),
      pool: { kind: 'inline' },
    })
    assert.equal(summary.openHandles, undefined)
    await new Promise((resolve) => setTimeout(resolve, 600))
  })
})
