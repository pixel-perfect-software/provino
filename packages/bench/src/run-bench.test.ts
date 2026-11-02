import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { BenchSubject } from '@provino/types'
import { BenchError } from './errors.ts'
import type { ExecOutcome, ExecRequest } from './exec.ts'
import {
  type BenchSpec,
  type BenchSubjectSpec,
  cacheDirProblem,
  DEFAULT_COLD_RUNS,
  DEFAULT_WARM_RUNS,
  type RunEvent,
  runBench,
} from './run-bench.ts'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function scratch(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'bench-run-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function subjectSpec(name: 'A' | 'B', dir: string): BenchSubjectSpec {
  const subject: BenchSubject = {
    runner: name === 'A' ? 'jest' : 'vitest',
    version: '1.0.0',
    isolation: 'runner-default',
    command: `run ${name}`,
  }
  return {
    subject,
    argv: [name],
    cwd: dir,
    env: { WHO: name },
    caches: [
      { kind: name === 'A' ? 'jest' : 'vite', path: join(dir, `${name}-tool`) },
      { kind: 'node-compile', path: join(dir, `${name}-node`) },
    ],
  }
}

interface Call {
  readonly who: string
  readonly index: number
  readonly selfCacheExisted: boolean
  readonly selfNodeCacheExisted: boolean
  readonly otherCacheExisted: boolean
  readonly request: ExecRequest
}

// A fake process runner. It records each call and what the caches looked like at that moment,
// then rewrites the caches the way a real tool would. `outcome` shapes the result of call `index`.
function fakeExec(
  dir: string,
  outcome: (who: string, index: number) => Partial<ExecOutcome> = () => ({}),
) {
  const calls: Call[] = []
  const exec = async (request: ExecRequest): Promise<ExecOutcome> => {
    const who = request.argv[0] ?? '?'
    const other = who === 'A' ? 'B' : 'A'
    const index = calls.length
    calls.push({
      who,
      index,
      selfCacheExisted: await exists(join(dir, `${who}-tool`)),
      selfNodeCacheExisted: await exists(join(dir, `${who}-node`)),
      otherCacheExisted: await exists(join(dir, `${other}-tool`)),
      request,
    })
    for (const suffix of ['tool', 'node']) {
      await mkdir(join(dir, `${who}-${suffix}`), { recursive: true })
      await writeFile(join(dir, `${who}-${suffix}`, 'entry'), String(index))
    }
    return { exitCode: 0, wallMs: 100 + index, ...outcome(who, index) }
  }
  return { calls, exec }
}

test('the protocol: a discarded warm-up, interleaved warm rounds, then interleaved cold rounds', async (t) => {
  const dir = await scratch(t)
  const { calls, exec } = fakeExec(dir, (who, index) =>
    // the warm-up of A reports a wall time that must not appear in any result
    who === 'A' && index === 0 ? { wallMs: 9999 } : {},
  )
  const results = await runBench({
    benchId: 'app-1',
    subjects: [subjectSpec('A', dir), subjectSpec('B', dir)],
    warmRuns: 3,
    coldRuns: 2,
    exec,
  })

  assert.deepEqual(calls.map((call) => call.who).join(''), 'AB' + 'ABABAB' + 'ABAB')
  const [warmA, coldA, warmB, coldB] = results
  assert.ok(warmA && coldA && warmB && coldB)
  assert.deepEqual(
    results.map((result) => [result.subject.runner, result.cache]),
    [
      ['jest', 'warm'],
      ['jest', 'cold'],
      ['vitest', 'warm'],
      ['vitest', 'cold'],
    ],
  )
  assert.ok(results.every((result) => result.benchId === 'app-1'))
  assert.deepEqual(warmA.wall.samplesMs, [102, 104, 106])
  assert.deepEqual(warmB.wall.samplesMs, [103, 105, 107])
  assert.deepEqual(coldA.wall.samplesMs, [108, 110])
  assert.deepEqual(coldB.wall.samplesMs, [109, 111])
  assert.equal(warmA.wall.runs, 3)
  assert.equal(coldA.wall.runs, 2)
  assert.ok(!results.some((result) => result.wall.samplesMs.includes(9999)))
})

test('the request carries the subject’s argv, cwd and env', async (t) => {
  const dir = await scratch(t)
  const { calls, exec } = fakeExec(dir)
  await runBench({
    benchId: 'app-1',
    subjects: [subjectSpec('A', dir)],
    warmRuns: 1,
    coldRuns: 1,
    exec,
  })
  assert.deepEqual(calls[0]?.request, {
    argv: ['A'],
    cwd: dir,
    env: { WHO: 'A' },
    timeoutMs: 30 * 60_000,
  })
})

test('cold runs find their own cache dirs deleted, warm runs find them kept', async (t) => {
  const dir = await scratch(t)
  const { calls, exec } = fakeExec(dir)
  await runBench({
    benchId: 'app-1',
    subjects: [subjectSpec('A', dir), subjectSpec('B', dir)],
    warmRuns: 3,
    coldRuns: 2,
    exec,
  })
  const warm = calls.slice(2, 8)
  const cold = calls.slice(8)
  assert.equal(cold.length, 4)
  assert.ok(
    warm.every((call) => call.selfCacheExisted),
    'warm runs keep their caches',
  )
  assert.ok(
    cold.every((call) => !call.selfCacheExisted),
    'cold runs start without their caches',
  )
  // every cache dir of the subject goes, not only the first
  assert.ok(warm.every((call) => call.selfNodeCacheExisted))
  assert.ok(cold.every((call) => !call.selfNodeCacheExisted))
  // Only the subject about to run is cleared: the other's caches are still there.
  assert.ok(cold.every((call) => call.otherCacheExisted))
})

test('a failing timed run is kept, and only that subject and cache state is not ok', async (t) => {
  const dir = await scratch(t)
  // call 5 is B's second warm run (calls 0-1 are warm-ups, then A B A B ...)
  const { exec } = fakeExec(dir, (_who, index) => (index === 5 ? { exitCode: 1, wallMs: 5 } : {}))
  const results = await runBench({
    benchId: 'app-1',
    subjects: [subjectSpec('A', dir), subjectSpec('B', dir)],
    warmRuns: 3,
    coldRuns: 2,
    exec,
  })
  const [warmA, coldA, warmB, coldB] = results
  assert.ok(warmA && coldA && warmB && coldB)
  assert.equal(warmB.ok, false)
  assert.deepEqual([warmA.ok, coldA.ok, coldB.ok], [true, true, true])
  // nothing dropped: the failing run's wall time is still a sample, and nothing was re-run
  assert.equal(warmB.wall.runs, 3)
  assert.deepEqual(warmB.wall.samplesMs, [103, 5, 107])
})

test('a failed warm-up does not make a result not ok', async (t) => {
  const dir = await scratch(t)
  const { exec } = fakeExec(dir, (who, index) =>
    who === 'A' && index === 0 ? { exitCode: 2 } : {},
  )
  const results = await runBench({
    benchId: 'app-1',
    subjects: [subjectSpec('A', dir)],
    warmRuns: 2,
    coldRuns: 1,
    exec,
  })
  assert.ok(results.every((result) => result.ok))
})

test('the defaults are 10 warm and 5 cold runs', async (t) => {
  const dir = await scratch(t)
  const { calls, exec } = fakeExec(dir)
  const results = await runBench({ benchId: 'app-1', subjects: [subjectSpec('A', dir)], exec })
  assert.equal(DEFAULT_WARM_RUNS, 10)
  assert.equal(DEFAULT_COLD_RUNS, 5)
  assert.equal(results[0]?.cache, 'warm')
  assert.equal(results[0]?.wall.samplesMs.length, 10)
  assert.equal(results[1]?.cache, 'cold')
  assert.equal(results[1]?.wall.samplesMs.length, 5)
  assert.equal(calls.length, 1 + 10 + 5)
})

test('CPU is the median across runs and peak RSS the maximum; missing figures are omitted', async (t) => {
  const dir = await scratch(t)
  const { exec } = fakeExec(dir, (who, index) =>
    who === 'A' ? { cpuUserMs: index * 10, cpuSysMs: index, peakRssMb: 50 + index } : {},
  )
  const results = await runBench({
    benchId: 'app-1',
    subjects: [subjectSpec('A', dir), subjectSpec('B', dir)],
    warmRuns: 3,
    coldRuns: 1,
    exec,
  })
  const [warmA, , warmB] = results
  assert.ok(warmA && warmB)
  // A's warm runs are calls 2, 4, 6
  assert.equal(warmA.cpuUserMs, 40)
  assert.equal(warmA.cpuSysMs, 4)
  assert.equal(warmA.peakRssMb, 56)
  assert.equal('cpuUserMs' in warmB, false)
  assert.equal('peakRssMb' in warmB, false)
})

test('onRun reports every run, with the discarded warm-up marked', async (t) => {
  const dir = await scratch(t)
  const { exec } = fakeExec(dir)
  const events: RunEvent[] = []
  await runBench({
    benchId: 'app-1',
    subjects: [subjectSpec('A', dir)],
    warmRuns: 2,
    coldRuns: 1,
    exec,
    onRun: (event) => events.push(event),
  })
  assert.deepEqual(
    events.map((event) => `${event.phase} ${event.round}/${event.rounds}`),
    ['warm-up 1/1', 'warm 1/2', 'warm 2/2', 'cold 1/1'],
  )
})

test('a bad spec is rejected before anything runs or is deleted', async (t) => {
  const dir = await scratch(t)
  await mkdir(join(dir, 'A-tool'))
  const { calls, exec } = fakeExec(dir)
  const base = subjectSpec('A', dir)
  const cases: [string, BenchSpec][] = [
    ['no subjects', { benchId: 'x', subjects: [], exec }],
    ['zero warm runs', { benchId: 'x', subjects: [base], warmRuns: 0, exec }],
    ['fractional cold runs', { benchId: 'x', subjects: [base], coldRuns: 1.5, exec }],
    ['empty argv', { benchId: 'x', subjects: [{ ...base, argv: [] }], exec }],
    ['no cache dirs', { benchId: 'x', subjects: [{ ...base, caches: [] }], exec }],
    [
      'relative cache dir',
      { benchId: 'x', subjects: [{ ...base, caches: [{ kind: 'jest', path: 'cache' }] }], exec },
    ],
    [
      'filesystem root as a cache dir',
      { benchId: 'x', subjects: [{ ...base, caches: [{ kind: 'jest', path: '/' }] }], exec },
    ],
  ]
  for (const [name, spec] of cases) {
    await assert.rejects(
      runBench(spec),
      (error) => error instanceof BenchError && error.code === 'BENCH_INVALID_SPEC',
      name,
    )
  }
  assert.equal(calls.length, 0)
  assert.ok(await exists(join(dir, 'A-tool')))
})

test('the per-run timeout defaults to 30 minutes and can be set', async (t) => {
  const dir = await scratch(t)
  const { calls, exec } = fakeExec(dir)
  await runBench({
    benchId: 'app-1',
    subjects: [subjectSpec('A', dir)],
    warmRuns: 1,
    coldRuns: 1,
    timeoutMs: 90_000,
    exec,
  })
  assert.ok(calls.length > 0)
  assert.ok(calls.every((call) => call.request.timeoutMs === 90_000))
})

test('a bad timeout is rejected before anything runs', async (t) => {
  const dir = await scratch(t)
  const { calls, exec } = fakeExec(dir)
  for (const timeoutMs of [0, -5, 1.5, Number.NaN, 2 ** 31]) {
    await assert.rejects(
      runBench({ benchId: 'x', subjects: [subjectSpec('A', dir)], timeoutMs, exec }),
      (error) => error instanceof BenchError && error.code === 'BENCH_INVALID_SPEC',
      String(timeoutMs),
    )
  }
  assert.equal(calls.length, 0)
})

// A run that could not be started is still a run: it is kept as a failure, so the other runs of the
// session are not thrown away with it.
test('a run that cannot be spawned is kept as a failed run, with a warning, and the bench carries on', async (t) => {
  const dir = await scratch(t)
  const { exec } = fakeExec(dir)
  const events: RunEvent[] = []
  let started = 0
  const results = await runBench({
    benchId: 'app-1',
    subjects: [subjectSpec('A', dir), subjectSpec('B', dir)],
    warmRuns: 3,
    coldRuns: 2,
    exec: async (request) => {
      started += 1
      // the 5th run is A's second warm run (1-2 are the warm-ups, then A B A B ...)
      if (started === 5) {
        throw new BenchError('BENCH_EXEC_FAILED', 'could not run A', {
          cause: new Error('spawn /bin/sh EMFILE'),
        })
      }
      return exec(request)
    },
    onRun: (event) => events.push(event),
  })
  const [warmA, coldA, warmB, coldB] = results
  assert.ok(warmA && coldA && warmB && coldB)
  assert.equal(warmA.ok, false)
  assert.deepEqual([coldA.ok, warmB.ok, coldB.ok], [true, true, true])
  assert.equal(warmA.wall.runs, 3, 'the failed run is a sample, not a gap')
  assert.equal(coldA.wall.runs, 2)
  assert.equal(events.length, 2 + 6 + 4, 'every run was reported and none repeated')
  const failed = events[4]?.outcome
  assert.ok(failed && failed.exitCode !== 0)
  assert.ok(
    failed.warnings?.some(
      (warning) => warning.includes('could not run A') && warning.includes('EMFILE'),
    ),
    String(failed.warnings),
  )
})

test('a spawn failure in the real exec is kept too, for every run', async (t) => {
  const dir = await scratch(t)
  const spec = { ...subjectSpec('A', dir), cwd: join(dir, 'does-not-exist') }
  const results = await runBench({
    benchId: 'app-1',
    subjects: [spec],
    warmRuns: 2,
    coldRuns: 1,
  })
  assert.deepEqual(
    results.map((result) => [result.cache, result.ok, result.wall.runs]),
    [
      ['warm', false, 2],
      ['cold', false, 1],
    ],
  )
})

test('an error from exec that is not a failure to run still ends the bench', async (t) => {
  const dir = await scratch(t)
  for (const error of [
    new BenchError('BENCH_UNSUPPORTED_PLATFORM', 'no sh'),
    new TypeError('bug'),
  ]) {
    await assert.rejects(
      runBench({
        benchId: 'x',
        subjects: [subjectSpec('A', dir)],
        exec: async () => {
          throw error
        },
      }),
      (thrown) => thrown === error,
    )
  }
})

test('a cache dir that cannot be deleted before a cold run is a BenchError naming the path', async (t) => {
  const dir = await scratch(t)
  await writeFile(join(dir, 'not-a-dir'), 'x')
  const stuck = join(dir, 'not-a-dir', 'cache')
  const { exec } = fakeExec(dir)
  const spec: BenchSubjectSpec = {
    ...subjectSpec('A', dir),
    caches: [{ kind: 'jest', path: stuck }],
  }
  await assert.rejects(
    runBench({ benchId: 'x', subjects: [spec], warmRuns: 1, coldRuns: 1, exec }),
    (error) =>
      error instanceof BenchError &&
      error.code === 'BENCH_CACHE_CLEAR_FAILED' &&
      error.message.includes(stuck) &&
      error.cause instanceof Error,
  )
})

// The guard runs before any deletion. Every path below is under a scratch directory or does not
// exist, so a guard that fails to reject cannot delete anything that matters.
test('cache dirs that could be a project, a home directory or a disk are refused before anything runs', async (t) => {
  const dir = await scratch(t)
  const home = join(dir, 'home')
  const work = join(dir, 'work')
  await mkdir(join(home, 'proj'), { recursive: true })
  await mkdir(work)
  const previousHome = process.env.HOME
  process.env.HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  })
  assert.equal(homedir(), home)

  const { calls, exec } = fakeExec(dir)
  // Each case trips one rule: the cwd is somewhere else unless the case is about the cwd.
  const elsewhere = '/bench-guard-cwd/a/b/c'
  const cases: [string, string, string][] = [
    ['a .. segment', `${dir}/x/../A-tool`, elsewhere],
    ['the subject’s own cwd', work, work],
    ['an ancestor of the subject’s cwd', work, join(work, 'inner')],
    ['the home directory', home, elsewhere],
    ['a directory that holds the home directory', dir, elsewhere],
    ['a path directly under the root', '/bench-guard-probe', elsewhere],
    ['a path two levels under the root', '/bench-guard-probe/cache', elsewhere],
  ]
  for (const [name, path, cwd] of cases) {
    await assert.rejects(
      runBench({
        benchId: 'x',
        subjects: [{ ...subjectSpec('A', dir), cwd, caches: [{ kind: 'jest', path }] }],
        exec,
      }),
      (error) => error instanceof BenchError && error.code === 'BENCH_INVALID_SPEC',
      name,
    )
  }
  assert.equal(calls.length, 0)
  assert.ok(await exists(join(home, 'proj')), 'nothing was deleted')
  assert.ok(await exists(work))
})

test('each cache dir rule gives its own reason', () => {
  const home = '/data/people/staff/me'
  const cwd = '/data/work/suite/jest'
  const problem = (path: string) => cacheDirProblem(path, { cwd, home })
  // allowed: next to the cwd, under it, and elsewhere deep enough
  assert.equal(problem('/data/work/suite/.cache/jest'), undefined)
  assert.equal(problem('/data/work/suite/jest/.cache'), undefined)
  assert.equal(problem(`${home}/.cache/provino`), undefined)
  assert.equal(problem('/a/b/c'), undefined)
  // refused
  assert.match(problem('cache') ?? '', /absolute/)
  assert.match(problem('/data/work/../people/staff/me/x') ?? '', /\.\. segment/)
  assert.match(problem('/data/work/suite/.cache/..') ?? '', /\.\. segment/)
  assert.match(problem('/') ?? '', /too close to the filesystem root/)
  assert.match(problem('/tmp') ?? '', /too close to the filesystem root/)
  assert.match(problem('/a/b') ?? '', /too close to the filesystem root/)
  assert.match(problem('/data/work/suite/jest') ?? '', /working directory/)
  assert.match(problem('/data/work/suite') ?? '', /working directory/)
  assert.match(problem(home) ?? '', /home directory/)
  assert.match(problem('/data/people/staff') ?? '', /home directory/)
  // a trailing slash or a doubled one is the same directory
  assert.match(problem('/data/work/suite/jest/') ?? '', /working directory/)
  assert.match(problem('/data//people//staff//me') ?? '', /home directory/)
  // a sibling whose name starts with the cwd's is not the cwd
  assert.equal(problem('/data/work/suite/jest-cache'), undefined)
  assert.equal(problem(`${home}-backup/x`), undefined)
})

test('the home directory defaults to os.homedir()', () => {
  assert.match(cacheDirProblem(homedir(), { cwd: '/a/b/c/d' }) ?? '', /home directory|too close/)
  assert.match(cacheDirProblem(`${homedir()}/..`, { cwd: '/a/b/c/d' }) ?? '', /\.\. segment/)
})
