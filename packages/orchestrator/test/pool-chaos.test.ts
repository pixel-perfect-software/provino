// T9.5's check: an end-to-end run of 200 generated files over a real pool, 3 of which crash the
// worker, 1 that runs out of memory and 1 that hangs, reports exactly those 5 as failed, each with
// its cause, and leaves no process behind.
//
// The coordinator runs in a child process of its own, in a process group of its own, so that the
// sweep afterwards (`ps` where it can run, and a `kill(-pgid, 0)` probe that needs no `ps`) can
// tell a worker that outlived the run from the test runner's own processes.
//
// Under threads a native fault ends the whole process (isolation.test.ts shows it), so the three
// crashing files leave by `process.exit(3)`, which ends only their thread: the nearest crash a
// thread can survive. The other two causes are the same under both pools.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RunPoolOptions } from '@provino/orchestrator'
import type { WorkerExit } from '@provino/types'
import { describe, it } from 'provino'
import { fixture, isRunning, takeWorkerPids, trackedProjects } from './support.ts'
import { assertGroupEmpty, killGroup } from './sweep.ts'

const makeProject = trackedProjects()

const OK_FILES = 195
const CRASHES = ['crash-1', 'crash-2', 'crash-3']
/**
 * The deadline for the file that hangs. It has room: every other file, the one that runs out of
 * memory included, must end well inside it on a busy machine. The run waits it out once. At 6 s a
 * loaded CI runner (Node 24, `03c6109`) killed the OOM file for its deadline before V8 reached the
 * heap limit, so the OOM must reach that limit long before this: 30 s, at the price of one 30 s
 * wait per pool kind.
 */
const FILE_TIMEOUT_MS = 30_000
/** Small enough that a runaway allocation ends quickly, large enough for the runtime itself. */
const HEAP_LIMIT_MB = 192
/**
 * When a worker is replaced after a file, below the heap cap. Without it the pool's default (at
 * least 512 MiB) sits above the cap, so a healthy worker that has served many files would be
 * stopped by the cap, as an OOM, rather than replaced by the pool, and a slow machine (more files
 * per worker, more garbage not yet collected) could fail a file that did nothing wrong. Replaced
 * first, a healthy worker never gets there, and the planted OOM stays the only one.
 */
const WORKER_MEMORY_LIMIT_BYTES = 160 * 1024 * 1024

type PoolKindUnderTest = 'forks' | 'threads'

interface Outcome {
  readonly path: string
  readonly state: string
  readonly workerExit: WorkerExit | null
  readonly errors: readonly string[]
}

interface ChaosRun {
  readonly reason: string
  readonly files: readonly Outcome[]
  readonly pgid: number
  readonly stderr: string
  readonly workerPids: readonly number[]
}

function sources(kind: PoolKindUnderTest): Record<string, string> {
  const files: Record<string, string> = {}
  for (let i = 0; i < OK_FILES; i++) {
    files[`ok-${String(i).padStart(3, '0')}.test.js`] =
      `test('ok ${i}', () => { expect(${i}).toBe(${i}) })\n`
  }
  for (const name of CRASHES) {
    files[`${name}.test.js`] =
      kind === 'forks'
        ? "test('segfault', () => { process.kill(process.pid, 'SIGSEGV') })\n"
        : "test('exits the thread', () => { process.exit(3) })\n"
  }
  files['oom.test.js'] =
    "test('runs out of memory', () => { const hold = []; for (;;) hold.push(new Array(2_000_000).fill(0)) })\n"
  // Busy for 120 s, past the file deadline, then done: a worker a killed test run leaves behind
  // ends by itself instead of spinning a core.
  files['hang.test.js'] =
    "test('hangs', () => { const end = Date.now() + 120_000; while (Date.now() < end) {} })\n"
  return files
}

/** Runs the coordinator child over the project and waits for it, killing its group if it hangs. */
async function chaos(
  kind: PoolKindUnderTest,
  custom: {
    readonly files?: Record<string, string>
    readonly pool?: RunPoolOptions
  } = {},
): Promise<ChaosRun> {
  const project = await makeProject(custom.files ?? sources(kind))
  const out = join(project.dir, '..', `chaos-${process.pid}-${kind}.json`)
  const child = spawn(
    process.execPath,
    [...process.execArgv, fileURLToPath(fixture('chaos-coordinator.ts')), project.dir, kind, out],
    {
      // Its own process group: everything it starts is in it.
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        CHAOS_POOL: JSON.stringify(
          custom.pool ?? {
            maxWorkers: 4,
            fileTimeoutMs: FILE_TIMEOUT_MS,
            heapLimitMb: HEAP_LIMIT_MB,
            recycle: { memoryLimitBytes: WORKER_MEMORY_LIMIT_BYTES },
          },
        ),
      },
    },
  )
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const pgid = child.pid as number
  const watchdog = setTimeout(() => killGroup(pgid), 120_000)
  try {
    const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null]
    assert.deepEqual({ code, signal }, { code: 0, signal: null }, stderr)
  } finally {
    clearTimeout(watchdog)
  }
  const result = JSON.parse(readFileSync(out, 'utf8')) as Pick<ChaosRun, 'reason' | 'files'>
  await rm(out, { force: true })
  // The forked workers noted their pids in a file named for the coordinator.
  return { ...result, pgid, stderr, workerPids: await takeWorkerPids(pgid) }
}

for (const kind of ['forks', 'threads'] as const) {
  describe(`200 files over ${kind}: 3 crashes, 1 OOM and 1 hang`, () => {
    it('fails exactly those 5, each with its cause, and leaves no child', async () => {
      const run = await chaos(kind)
      try {
        assert.equal(run.files.length, OK_FILES + CRASHES.length + 2, 'every file has a result')
        const failed = run.files.filter((file) => file.state === 'fail')
        assert.deepEqual(
          failed.map((file) => file.path).sort(),
          [...CRASHES.map((name) => `${name}.test.js`), 'hang.test.js', 'oom.test.js'].sort(),
          'exactly the five',
        )
        assert.equal(run.reason, 'failed')

        const byPath = new Map(failed.map((file) => [file.path, file]))
        for (const name of CRASHES) {
          const file = byPath.get(`${name}.test.js`)
          assert.deepEqual(
            file?.workerExit,
            kind === 'forks'
              ? { type: 'signal', signal: 'SIGSEGV', likelyOom: false }
              : { type: 'exit', code: 3 },
            name,
          )
        }
        assert.deepEqual(byPath.get('oom.test.js')?.workerExit, {
          type: 'oom',
          limitMb: HEAP_LIMIT_MB,
        })
        assert.deepEqual(byPath.get('hang.test.js')?.workerExit, {
          type: 'timeout',
          phase: 'file',
          limitMs: FILE_TIMEOUT_MS,
        })
        assert.match(
          byPath.get('hang.test.js')?.errors[0] ?? '',
          new RegExp(`deadline of ${FILE_TIMEOUT_MS} ms`),
        )
        assert.match(byPath.get('oom.test.js')?.errors[0] ?? '', /out of memory/)
        assert.ok(
          run.files.filter((file) => file.state === 'pass').length === OK_FILES,
          'the other 195 pass',
        )

        // No child survives: every forked worker is gone, and nothing is left in the group.
        for (const pid of run.workerPids) assert.equal(isRunning(pid), false, `worker ${pid}`)
        if (kind === 'forks') assert.ok(run.workerPids.length >= 5, 'workers were recorded')
        await assertGroupEmpty(run.pgid, `pool-chaos (${kind})`)
      } finally {
        killGroup(run.pgid)
      }
    })
  })
}

describe('recycling over real forks (T9.5)', () => {
  const passingFiles = (count: number): Record<string, string> =>
    Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        `ok-${String(i).padStart(2, '0')}.test.js`,
        `test('ok', () => { expect(${i}).toBe(${i}) })
`,
      ]),
    )

  it('maxFilesPerWorker: 3 gives a fresh worker every 3 files', async () => {
    const run = await chaos('forks', {
      files: passingFiles(30),
      pool: { maxWorkers: 1, recycle: { maxFilesPerWorker: 3 } },
    })
    try {
      assert.equal(run.reason, 'passed')
      assert.equal(run.files.length, 30)
      assert.equal(new Set(run.workerPids).size, 10, '30 files, 3 to a worker: 10 workers')
      for (const pid of run.workerPids) assert.equal(isRunning(pid), false, `worker ${pid}`)
    } finally {
      killGroup(run.pgid)
    }
  })

  it('a file over memoryLimitBytes replaces its worker: a limit of 1 byte is a worker per file', async () => {
    const run = await chaos('forks', {
      files: passingFiles(6),
      pool: { maxWorkers: 1, recycle: { memoryLimitBytes: 1 } },
    })
    try {
      assert.equal(run.reason, 'passed')
      assert.equal(new Set(run.workerPids).size, 6, 'six files, six workers')
    } finally {
      killGroup(run.pgid)
    }
  })

  it('a fork whose RSS is over the limit and whose heapUsed is under it is not replaced (jest-worker compares heapUsed)', async () => {
    // 256 MB of Buffer memory, written so the pages are resident, held on `process` (shared by
    // every file of the fork): RSS is far over the 128 MiB limit, the isolate's heap is not.
    const files = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [
        `native-${i}.test.js`,
        `test('holds native memory', () => {
  process.__native ??= Buffer.alloc(256 * 1024 * 1024, 1)
  expect(process.__native.length).toBe(256 * 1024 * 1024)
})
`,
      ]),
    )
    const run = await chaos('forks', {
      files,
      pool: { maxWorkers: 1, recycle: { memoryLimitBytes: 128 * 1024 * 1024 } },
    })
    try {
      assert.equal(run.reason, 'passed', run.stderr)
      assert.equal(new Set(run.workerPids).size, 1, 'one worker serves all six files')
    } finally {
      killGroup(run.pgid)
    }
  })

  it('a fork whose heapUsed grows past the limit is replaced', async () => {
    // Held on `process`, so it survives the file: 2e7 slots is about 160 MB of heap.
    const files = Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [
        `heap-${i}.test.js`,
        `test('holds heap', () => {
  process.__heap = new Array(20_000_000).fill(${i})
  expect(process.__heap.length).toBe(20_000_000)
})
`,
      ]),
    )
    const run = await chaos('forks', {
      files,
      pool: { maxWorkers: 1, recycle: { memoryLimitBytes: 100 * 1024 * 1024 } },
    })
    try {
      assert.equal(run.reason, 'passed', run.stderr)
      assert.equal(new Set(run.workerPids).size, 4, 'four files, four workers')
    } finally {
      killGroup(run.pgid)
    }
  })

  it('a fork that only makes garbage is kept: the worker collects once before it reports, so what the pool compares is what it holds', async () => {
    // Each file allocates 160 MB nothing refers to once its test returns: the isolate's used heap
    // is over the 128 MiB limit when the file ends and its live heap (about 70 MB) far under it.
    // jest-worker compares the heap as it is and would replace the worker after every file here;
    // the worker collects before it reports, so the same worker serves them all (DIVERGENCES:
    // collect before recycling, Tyler 2026-11-16).
    const files = Object.fromEntries(
      Array.from({ length: 3 }, (_, i) => [
        `garbage-${i}.test.js`,
        `test('makes garbage', () => {
  const scratch = new Array(20_000_000).fill(${i})
  expect(scratch.length).toBe(20_000_000)
})
`,
      ]),
    )
    const run = await chaos('forks', {
      files,
      pool: { maxWorkers: 1, recycle: { memoryLimitBytes: 128 * 1024 * 1024 } },
    })
    try {
      assert.equal(run.reason, 'passed', run.stderr)
      assert.equal(new Set(run.workerPids).size, 1, 'one worker serves all three files')
    } finally {
      killGroup(run.pgid)
    }
  })

  it('without a limit one worker serves every file (the control)', async () => {
    const run = await chaos('forks', {
      files: passingFiles(6),
      pool: { maxWorkers: 1, recycle: { memoryLimitBytes: Number.MAX_SAFE_INTEGER } },
    })
    try {
      assert.equal(new Set(run.workerPids).size, 1)
    } finally {
      killGroup(run.pgid)
    }
  })
})
