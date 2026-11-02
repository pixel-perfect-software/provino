import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { BenchRecord } from '@provino/types'
import { type CliDeps, runCli } from './commands.ts'
import { BenchError } from './errors.ts'
import type { ExecOutcome, ExecRequest } from './exec.ts'
import { makeRepo } from './internal/test-repo.ts'

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
  t: { after(fn: () => Promise<void>): void },
  options?: {
    readonly dirty?: boolean
    readonly repo?: boolean
    readonly onRun?: (
      index: number,
      paths: { readonly dir: string; readonly out: string },
    ) => Promise<Partial<ExecOutcome>>
  },
): Promise<Setup> {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'bench-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const repoRoot = join(dir, 'repo')
  if (options?.repo === false) await mkdir(repoRoot)
  else await makeRepo(repoRoot, { dirty: options?.dirty === true })

  const out = join(dir, 'records', 'run.json')
  const calls: ExecRequest[] = []
  const clockReadsAtRun: number[] = []
  let clockReads = 0
  const deps: CliDeps = {
    repoRoot,
    suitesRoot: join(dir, 'suites'),
    resultsDir: join(dir, 'results'),
    now: () => new Date(START + 1000 * clockReads++),
    exec: async (request) => {
      const index = calls.length
      calls.push(request)
      clockReadsAtRun.push(clockReads)
      return { exitCode: 0, wallMs: 100 + index, ...(await options?.onRun?.(index, { dir, out })) }
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
