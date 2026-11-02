import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { BenchSubject } from '@provino/types'
import { BenchError } from './errors.ts'
import type { ExecOutcome, ExecRequest } from './exec.ts'
import {
  type BenchSpec,
  type BenchSubjectSpec,
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
  assert.deepEqual(calls[0]?.request, { argv: ['A'], cwd: dir, env: { WHO: 'A' } })
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
