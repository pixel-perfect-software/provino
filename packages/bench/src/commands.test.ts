import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'
import type { BenchRecord } from '@provino/types'
import { type CliDeps, runCli } from './commands.ts'
import { BenchError } from './errors.ts'
import type { ExecOutcome, ExecRequest } from './exec.ts'
import { assertBenchRecord, parityOf, scratch } from './internal/test-helpers.ts'
import { makeRepo } from './internal/test-repo.ts'
import type { StatusParity } from './parity.ts'

const START = Date.UTC(2026, 10, 2, 10, 11, 12)

interface Setup {
  readonly dir: string
  readonly out: string
  readonly calls: ExecRequest[]
  readonly stdout: string[]
  readonly stderr: string[]
  readonly clockReadsAtRun: number[]
  readonly deps: CliDeps
  run(argv: readonly string[]): Promise<number>
}

// A bench with a fake process runner, a throwaway git checkout and its own suite and record
// directories. `onRun` can fail or change a run; by default every run exits 0 after 100 ms.
async function setup(
  t: Pick<TestContext, 'after'>,
  options?: {
    readonly dirty?: boolean
    readonly repo?: boolean
    readonly onRun?: (
      index: number,
      paths: { readonly dir: string; readonly out: string },
      request: ExecRequest,
    ) => Promise<Partial<ExecOutcome>>
  },
): Promise<Setup> {
  const dir = await scratch(t, 'bench-cli-')
  const repoRoot = join(dir, 'repo')
  if (options?.repo === false) await mkdir(repoRoot)
  else await makeRepo(repoRoot, { dirty: options?.dirty === true })

  const out = join(dir, 'records', 'run.json')
  const calls: ExecRequest[] = []
  const clockReadsAtRun: number[] = []
  let clockReads = 0
  const deps: CliDeps = {
    paths: { repoRoot, suitesRoot: join(dir, 'suites'), resultsDir: join(dir, 'results') },
    now: () => new Date(START + 1000 * clockReads++),
    exec: async (request) => {
      const index = calls.length
      calls.push(request)
      clockReadsAtRun.push(clockReads)
      return {
        exitCode: 0,
        wallMs: 100 + index,
        ...(await options?.onRun?.(index, { dir, out }, request)),
      }
    },
  }
  const stdout: string[] = []
  const stderr: string[] = []
  const io = { out: (text: string) => stdout.push(text), err: (text: string) => stderr.push(text) }
  return {
    dir,
    out,
    calls,
    stdout,
    stderr,
    clockReadsAtRun,
    deps,
    run: (argv) => runCli(argv, io, deps),
  }
}

const SHORT = ['--warm', '2', '--cold', '1']

function runArgs(out: string, ...rest: readonly string[]): string[] {
  return ['run', 'app-1', '--runner', 'jest', '--out', out, ...rest]
}

async function readRecord(path: string): Promise<BenchRecord> {
  return JSON.parse(await readFile(path, 'utf8')) as BenchRecord
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

test('a git failure stops the run before any subject starts', async (t) => {
  const bench = await setup(t, { repo: false })
  assert.equal(await bench.run(runArgs(bench.out, ...SHORT)), 1)
  assert.match(bench.stderr.join('\n'), /BENCH_GIT_UNAVAILABLE/)
  assert.equal(bench.calls.length, 0, 'no run may start when the commit cannot be read')
  assert.equal(await exists(bench.out), false)
})

test('an --out that already exists is refused before any run, and the file is untouched', async (t) => {
  const bench = await setup(t)
  await mkdir(join(bench.dir, 'records'))
  await writeFile(bench.out, 'precious')
  assert.equal(await bench.run(runArgs(bench.out, ...SHORT)), 1)
  assert.match(bench.stderr.join('\n'), /BENCH_OUT_INVALID: .*already exists/)
  assert.equal(bench.calls.length, 0, 'the existing record must be refused before the runs')
  assert.equal(await readFile(bench.out, 'utf8'), 'precious')
})

test('an --out that is a directory, or sits under a file, is refused before any run', async (t) => {
  const bench = await setup(t)
  await mkdir(join(bench.dir, 'a-directory'))
  await writeFile(join(bench.dir, 'a-file'), 'x')
  for (const out of [join(bench.dir, 'a-directory'), join(bench.dir, 'a-file', 'run.json')]) {
    bench.stderr.length = 0
    assert.equal(await bench.run(runArgs(out, ...SHORT)), 1, out)
    assert.match(bench.stderr.join('\n'), /BENCH_OUT_INVALID/, out)
  }
  assert.equal(bench.calls.length, 0)
})

test('the default record path is never reused: a second run in the same second is refused', async (t) => {
  const bench = await setup(t)
  const fixedClock: CliDeps = { ...bench.deps, now: () => new Date(START) }
  const io = { out: () => {}, err: (text: string) => bench.stderr.push(text) }
  const argv = ['run', 'app-1', '--runner', 'jest', ...SHORT]
  assert.equal(await runCli(argv, io, fixedClock), 0)
  const calls = bench.calls.length
  assert.equal(await runCli(argv, io, fixedClock), 1)
  assert.match(bench.stderr.join('\n'), /BENCH_OUT_INVALID/)
  assert.equal(bench.calls.length, calls, 'the refused run must not start')
  assert.equal((await readdir(join(bench.dir, 'results'))).length, 1)
})

test('a run that cannot be spawned is kept as a failed run and the record is still written', async (t) => {
  const bench = await setup(t, {
    onRun: async (index) => {
      // calls: 0 warm-up, 1-2 warm, 3 cold
      if (index === 2) throw new BenchError('BENCH_EXEC_FAILED', 'could not run jest')
      return {}
    },
  })
  assert.equal(await bench.run(runArgs(bench.out, ...SHORT)), 1)
  const record = await readRecord(bench.out)
  const [warm, cold] = record.results
  assert.ok(warm && cold)
  assert.equal(warm.ok, false)
  assert.equal(warm.wall.runs, 2, 'the failed run is a sample, not a gap')
  assert.equal(cold.ok, true)
  assert.match(bench.stdout.join('\n'), /jest warm had a failing run/)
})

test('the summary is printed, and the record kept in a temp file and on stderr, when it cannot be moved into place', async (t) => {
  const bench = await setup(t, {
    // Another process creates the record while the runs are going.
    onRun: async (index, { out }) => {
      if (index === 3) await writeFile(out, 'intruder')
      return {}
    },
  })
  await mkdir(join(bench.dir, 'records'))
  assert.equal(await bench.run(runArgs(bench.out, ...SHORT)), 1)
  const stderr = bench.stderr.join('\n')
  assert.match(stderr, /BENCH_OUT_WRITE_FAILED/)
  assert.equal(await readFile(bench.out, 'utf8'), 'intruder', 'a record is never overwritten')
  assert.match(bench.stdout.join('\n'), /\[local\] .*median ms/)
  const kept = (await readdir(join(bench.dir, 'records'))).filter((name) => name.endsWith('.tmp'))
  assert.equal(kept.length, 1)
  assert.ok(stderr.includes(join(bench.dir, 'records', kept[0] ?? '')))
  const keptRecord = await readRecord(join(bench.dir, 'records', kept[0] ?? ''))
  assert.equal(keptRecord.schemaVersion, 1)
  const printed = bench.stderr.find((line) => line.startsWith('{'))
  assert.equal((JSON.parse(printed ?? 'null') as BenchRecord).schemaVersion, 1)
})

test('desktop and pinned refuse a dirty tree before any run starts', async (t) => {
  const bench = await setup(t, { dirty: true })
  for (const label of ['desktop', 'pinned']) {
    bench.stderr.length = 0
    assert.equal(
      await bench.run(runArgs(bench.out, '--label', label, '--warm', '10', '--cold', '5')),
      1,
      label,
    )
    assert.match(bench.stderr.join('\n'), /BENCH_DIRTY_TREE/, label)
  }
  assert.equal(bench.calls.length, 0, 'no run may start on a dirty tree')
  assert.equal(await exists(bench.out), false)
})

test('a clean tree is recorded as clean, and a local run on a dirty one is recorded and shown as dirty', async (t) => {
  const clean = await setup(t)
  assert.equal(
    await clean.run(runArgs(clean.out, '--label', 'desktop', '--warm', '10', '--cold', '5')),
    0,
  )
  assert.equal((await readRecord(clean.out)).ref.dirty, false)
  assert.match(clean.stdout.join('\n'), /\[desktop\] commit [0-9a-f]{7} \(clean\)/)

  const dirty = await setup(t, { dirty: true })
  assert.equal(await dirty.run(runArgs(dirty.out, ...SHORT)), 0)
  assert.equal((await readRecord(dirty.out)).ref.dirty, true)
  assert.match(dirty.stdout.join('\n'), /\[local\] commit [0-9a-f]{7} \(dirty: /)
})

test('the run ref is read once, before the first run', async (t) => {
  const bench = await setup(t)
  assert.equal(await bench.run(runArgs(bench.out, ...SHORT)), 0)
  assert.ok(bench.clockReadsAtRun.length > 0)
  assert.ok(
    bench.clockReadsAtRun.every((reads) => reads === 1),
    `clock reads seen by each run: ${bench.clockReadsAtRun.join()}`,
  )
  assert.equal((await readRecord(bench.out)).ref.date, new Date(START).toISOString())
})

test('a local run below the protocol says so in the summary, and a full one does not', async (t) => {
  const short = await setup(t)
  assert.equal(await short.run(runArgs(short.out, ...SHORT)), 0)
  assert.match(
    short.stdout.join('\n'),
    /\[local\] WARNING: fewer runs than the R5 protocol \(10 warm, 5 cold\)/,
  )
  const full = await setup(t)
  assert.equal(await full.run(runArgs(full.out, '--warm', '10', '--cold', '5')), 0)
  assert.doesNotMatch(full.stdout.join('\n'), /fewer runs than the R5 protocol/)
})

test('--timeout reaches every run', async (t) => {
  const bench = await setup(t)
  assert.equal(await bench.run(runArgs(bench.out, '--timeout', '7', ...SHORT)), 0)
  assert.ok(bench.calls.length > 0)
  assert.ok(bench.calls.every((call) => call.timeoutMs === 7 * 60_000))
})

test('run takes provino: its subject is provino:jest at registry, with its results cache kept', async (t) => {
  const bench = await setup(t)
  assert.equal(
    await bench.run([
      'run',
      'app-1',
      '--runner',
      'jest',
      '--runner',
      'provino',
      '--out',
      bench.out,
      ...SHORT,
    ]),
    0,
  )
  const record = await readRecord(bench.out)
  assertBenchRecord(record)
  const provino = record.results.filter((entry) => entry.subject.runner === 'provino:jest')
  assert.equal(provino.length, 2)
  assert.ok(provino.every((entry) => entry.subject.isolation === 'registry'))
  assert.ok(
    bench.calls.every((call) => !call.argv.includes('--no-cache')),
    'a timed run keeps the results cache',
  )
  assert.match(bench.stdout.join('\n'), /app-1 provino:jest \(registry\)\/jest warm: median ratio/)
})

// ---- kill-check ----

const isProvino = (call: ExecRequest): boolean =>
  call.argv.some((arg) => arg.endsWith('provino/src/cli.ts'))
const configOf = (call: ExecRequest): string | undefined =>
  call.argv[call.argv.indexOf('--config') + 1]

// Walls by subject: Jest 1000 ms, Provino registry 200, none 150.
const bySubject = async (_index: number, _paths: unknown, request: ExecRequest) => ({
  wallMs: !isProvino(request) ? 1000 : configOf(request) === 'provino.none.config.mjs' ? 150 : 200,
})
const fixedWall = async () => ({ wallMs: 100 })

function withParity(bench: Setup, read: (suite: string) => Promise<StatusParity>): string[] {
  const reads: string[] = []
  ;(bench.deps as { readParity?: CliDeps['readParity'] }).readParity = async (suite) => {
    reads.push(suite.name)
    return read(suite.name)
  }
  return reads
}

test('kill-check --dry-run runs Jest for every subject, reads no parity, and is NO-GO at ratio 1.000', async (t) => {
  const bench = await setup(t, { onRun: fixedWall })
  const reads = withParity(bench, async () => parityOf(1, 1))
  assert.equal(await bench.run(['kill-check', '--dry-run', '--out', bench.out]), 1)
  const stdout = bench.stdout.join('\n')
  assert.match(stdout, /NO-GO/)
  assert.match(stdout, /1\.000/)
  assert.equal(stdout.match(/ {2}PENDING:/g)?.length, 5)
  assert.match(stdout, /PROVISIONAL \(local\)/)
  assert.match(stdout, /DRY RUN/)
  // app-500: 3 subjects (Jest, registry stand-in, none stand-in); mock-heavy-500: 2 (Jest, registry
  // stand-in); each 1 warm-up + 10 warm + 5 cold.
  assert.equal(bench.calls.length, 80)
  assert.ok(
    bench.calls.every((call) => !isProvino(call)),
    'every argv is Jest',
  )
  assert.ok(bench.calls.every((call) => configOf(call) === 'jest.config.json'))
  assert.deepEqual(reads, [], 'a dry run reads no parity')
  const record = await readRecord(bench.out)
  assertBenchRecord(record)
  assert.deepEqual([...new Set(record.results.map((entry) => entry.subject.runner))].sort(), [
    'jest',
    'jest-as-provino',
  ])
  assert.deepEqual([...new Set(record.results.map((entry) => entry.subject.isolation))].sort(), [
    'none',
    'registry',
    'runner-default',
  ])
})

test('kill-check names its default record for a dry run apart from a real one', async (t) => {
  const bench = await setup(t, { onRun: fixedWall })
  assert.equal(await bench.run(['kill-check', '--dry-run']), 1)
  const names = await readdir(join(bench.dir, 'results'))
  assert.equal(names.length, 1)
  assert.match(names[0] ?? '', /-kill-check-dry-run-[0-9a-f]{7}\.json$/)
})

test('kill-check measures Provino at both tiers against Jest and is a provisional GO when it is fast enough', async (t) => {
  const bench = await setup(t, { onRun: bySubject })
  const reads = withParity(bench, async () => parityOf(4000, 4000))
  assert.equal(await bench.run(['kill-check', '--out', bench.out]), 0)
  const stdout = bench.stdout.join('\n')
  assert.match(
    stdout,
    /app-500 +100\.0% \(4000\/4000\) +0\.200 \(0\.200-0\.200\) +pass +0\.200 \(0\.200-0\.200\) +pass/,
  )
  assert.match(stdout, /isolation app-500 registry\/none warm: median ratio 1\.333/)
  assert.match(
    stdout,
    /mock-heavy-500 +100\.0% \(4000\/4000\) +0\.200 \(0\.200-0\.200\) +pass +0\.200 \(0\.200-0\.200\) +pass/,
  )
  assert.match(stdout, /VERDICT: GO, PROVISIONAL \(local\)/)
  assert.match(stdout, /2 of 7 suites measured, 5 PENDING/)
  assert.match(stdout, /app-500 provino:jest \(none\)\/jest cold: median ratio 0\.150/)
  assert.deepEqual(reads, ['app-500', 'mock-heavy-500'])
  assert.equal(bench.calls.length, 80)

  const record = await readRecord(bench.out)
  assertBenchRecord(record)
  const subjects = new Set(
    record.results.map(
      (entry) => `${entry.benchId} ${entry.subject.runner}/${entry.subject.isolation}`,
    ),
  )
  assert.deepEqual([...subjects].sort(), [
    'app-500 jest/runner-default',
    'app-500 provino:jest/none',
    'app-500 provino:jest/registry',
    'mock-heavy-500 jest/runner-default',
    'mock-heavy-500 provino:jest/registry',
  ])
  assert.equal(record.results.length, 10)

  const provino = bench.calls.filter(isProvino)
  assert.equal(provino.length, 48)
  assert.ok(
    provino.every((call) => !call.argv.includes('--no-cache')),
    'the results cache is kept (D19)',
  )
  assert.equal(provino.filter((call) => configOf(call) === 'provino.config.mjs').length, 32)
  assert.equal(provino.filter((call) => configOf(call) === 'provino.none.config.mjs').length, 16)
})

test('a suite that throws keeps no result and fails its checks; the other suite keeps its runs', async (t) => {
  const bench = await setup(t, { onRun: bySubject })
  const reads = withParity(bench, async () => parityOf(4000, 4000))
  // mock-heavy-500's directory is a file, so writing the suite throws before its runs.
  await mkdir(join(bench.dir, 'suites'), { recursive: true })
  await writeFile(join(bench.dir, 'suites', 'mock-heavy-500'), 'not a directory')
  assert.equal(await bench.run(['kill-check', '--out', bench.out]), 1)
  assert.match(
    bench.stderr.join('\n'),
    /\[local\] mock-heavy-500 FAILED before its runs were recorded: .*Its checks fail with no result/,
  )
  const stdout = bench.stdout.join('\n')
  assert.match(stdout, /NO-GO: mock-heavy-500 warm: no /)
  assert.match(stdout, /NO-GO: mock-heavy-500 parity: no parity was read/)
  assert.match(stdout, /VERDICT: NO-GO, PROVISIONAL \(local\)/)
  assert.deepEqual(reads, ['app-500'])
  assert.equal(bench.calls.length, 48, "app-500's runs all happen")
  const record = await readRecord(bench.out)
  assertBenchRecord(record)
  assert.deepEqual([...new Set(record.results.map((entry) => entry.benchId))], ['app-500'])
  assert.equal(record.results.length, 6)
})

test('kill-check keeps measuring when parity is low, and says NO-GO', async (t) => {
  const bench = await setup(t, { onRun: bySubject })
  withParity(bench, async () => parityOf(3000, 4000))
  assert.equal(await bench.run(['kill-check', '--out', bench.out]), 1)
  const stdout = bench.stdout.join('\n')
  assert.match(stdout, /NO-GO: app-500 parity: 3000\/4000/)
  assert.match(stdout, /VERDICT: NO-GO, PROVISIONAL \(local\)/)
  assert.equal(bench.calls.length, 80, 'every timed run still happens')
  assert.equal((await readRecord(bench.out)).results.length, 10)
})

test('a parity read that cannot compare, or throws, fails the gate closed', async (t) => {
  const unreadable = await setup(t, { onRun: bySubject })
  withParity(unreadable, async () =>
    parityOf(0, 0, { ok: false, unavailable: 'provino wrote no valid report' }),
  )
  assert.equal(await unreadable.run(['kill-check', '--out', unreadable.out]), 1)
  assert.match(
    unreadable.stdout.join('\n'),
    /NO-GO: app-500 parity: could not compare: provino wrote no valid report/,
  )
  assert.equal(unreadable.calls.length, 80)

  const thrown = await setup(t, { onRun: bySubject })
  withParity(thrown, async () => {
    throw new BenchError('BENCH_EXEC_FAILED', 'could not run jest')
  })
  assert.equal(await thrown.run(['kill-check', '--out', thrown.out]), 1)
  assert.match(
    thrown.stdout.join('\n'),
    /NO-GO: app-500 parity: could not compare: BENCH_EXEC_FAILED/,
  )
  assert.equal(thrown.calls.length, 80)
})

test('kill-check is NO-GO when Provino is not fast enough, and exits 1', async (t) => {
  const bench = await setup(t, { onRun: fixedWall })
  withParity(bench, async () => parityOf(4000, 4000))
  assert.equal(await bench.run(['kill-check', '--out', bench.out]), 1)
  assert.match(bench.stdout.join('\n'), /NO-GO: app-500 warm/)
})

test('kill-check refuses a dirty desktop tree, and an existing --out, before any run or parity read', async (t) => {
  const dirty = await setup(t, { dirty: true })
  const reads = withParity(dirty, async () => parityOf(1, 1))
  assert.equal(await dirty.run(['kill-check', '--label', 'desktop', '--out', dirty.out]), 1)
  assert.match(dirty.stderr.join('\n'), /BENCH_DIRTY_TREE/)
  assert.equal(dirty.calls.length, 0)
  assert.deepEqual(reads, [])

  const existing = await setup(t)
  const existingReads = withParity(existing, async () => parityOf(1, 1))
  await mkdir(join(existing.dir, 'records'))
  await writeFile(existing.out, 'precious')
  assert.equal(await existing.run(['kill-check', '--out', existing.out]), 1)
  assert.match(existing.stderr.join('\n'), /BENCH_OUT_INVALID: .*already exists/)
  assert.equal(existing.calls.length, 0)
  assert.deepEqual(existingReads, [])
  assert.equal(await readFile(existing.out, 'utf8'), 'precious')
})

test('kill-check on a usage error exits 2 before any run', async (t) => {
  const bench = await setup(t)
  assert.equal(await bench.run(['kill-check', '--dry-run', '--label', 'desktop']), 2)
  assert.equal(await bench.run(['kill-check', 'app-500']), 2)
  assert.equal(bench.calls.length, 0)
})

test('kill-check saves the record before printing, so a failing summary loses no run', async (t) => {
  // A zero wall time makes the summary's ratio throw (a zero denominator).
  const bench = await setup(t, { onRun: async () => ({ wallMs: 0 }) })
  withParity(bench, async () => parityOf(1, 1))
  assert.equal(await bench.run(['kill-check', '--dry-run', '--out', bench.out]), 1)
  assert.match(bench.stderr.join('\n'), /provino-bench: BENCH_/)
  assertBenchRecord(await readRecord(bench.out))
})

test('kill-check that cannot place its record still prints the verdict, then dumps the JSON and fails', async (t) => {
  const bench = await setup(t, {
    onRun: async (index, { out }) => {
      if (index === 3) await writeFile(out, 'intruder')
      return { wallMs: 100 }
    },
  })
  await mkdir(join(bench.dir, 'records'))
  withParity(bench, async () => parityOf(1, 1))
  assert.equal(await bench.run(['kill-check', '--dry-run', '--out', bench.out]), 1)
  const stderr = bench.stderr.join('\n')
  assert.match(stderr, /BENCH_OUT_WRITE_FAILED/)
  assert.match(bench.stdout.join('\n'), /VERDICT: NO-GO/)
  assert.ok(!bench.stdout.some((line) => line.includes('] wrote ')), 'nothing was written')
  const printed = bench.stderr.find((line) => line.startsWith('{'))
  assert.equal((JSON.parse(printed ?? 'null') as BenchRecord).schemaVersion, 1)
})

test('the wrote line comes after the summary and the verdict', async (t) => {
  const bench = await setup(t, { onRun: bySubject })
  withParity(bench, async () => parityOf(4000, 4000))
  assert.equal(await bench.run(['kill-check', '--out', bench.out]), 0)
  assert.match(bench.stdout.at(-1) ?? '', /^\[local\] wrote /)
  assert.ok(bench.stdout.findIndex((line) => line.includes('VERDICT')) < bench.stdout.length - 1)
})

test('run saves the record before printing the summary', async (t) => {
  const bench = await setup(t, { onRun: async () => ({ wallMs: 0 }) })
  const code = await bench.run(['run', 'app-1', '--runner', 'jest', '--out', bench.out, ...SHORT])
  assert.ok(code === 0 || code === 1)
  assertBenchRecord(await readRecord(bench.out))
  assert.match(bench.stdout.at(-1) ?? '', /^\[local\] wrote /)
})

test('a parity read that throws a plain Error fails the gate closed with its message', async (t) => {
  const bench = await setup(t, { onRun: bySubject })
  withParity(bench, async () => {
    throw new Error('ENOENT: no such file, open report.json')
  })
  assert.equal(await bench.run(['kill-check', '--out', bench.out]), 1)
  assert.match(
    bench.stdout.join('\n'),
    /NO-GO: app-500 parity: could not compare: .*ENOENT: no such file/,
  )
  assert.equal(bench.calls.length, 80, 'every timed run still happens')
  assertBenchRecord(await readRecord(bench.out))
})
