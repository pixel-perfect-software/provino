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
import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { WorkerExit } from '@provino/types'
import { fixture, isRunning, trackedProjects } from './support.ts'
import { killGroup, sweep } from './sweep.ts'

const makeProject = trackedProjects()

const OK_FILES = 195
const CRASHES = ['crash-1', 'crash-2', 'crash-3']
/** The deadline for the file that hangs. Short: the run waits it out once. */
const FILE_TIMEOUT_MS = 2000
/** Small enough that a runaway allocation ends quickly, large enough for the runtime itself. */
const HEAP_LIMIT_MB = 192

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
  readonly coordinatorPid: number
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
    "test('runs out of memory', () => { const hold = []; for (;;) hold.push(new Array(100_000).fill({ hold })) })\n"
  files['hang.test.js'] = "test('hangs', () => { for (;;) {} })\n"
  return files
}

/** Runs the coordinator child over the project and waits for it, killing its group if it hangs. */
async function chaos(kind: PoolKindUnderTest): Promise<ChaosRun> {
  const project = await makeProject(sources(kind))
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
        CHAOS_OPTIONS: JSON.stringify({
          maxWorkers: 4,
          fileTimeoutMs: FILE_TIMEOUT_MS,
          heapLimitMb: HEAP_LIMIT_MB,
        }),
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
  const pidFile = join(tmpdir(), `provino-pids-${pgid}`)
  const workerPids = existsSync(pidFile)
    ? readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number)
    : []
  await rm(pidFile, { force: true })
  return { ...result, pgid, coordinatorPid: pgid, stderr, workerPids }
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
        const swept = await sweep(run.pgid)
        assert.equal(swept.alive, false, 'kill(-pgid, 0): nothing is left in the group')
        if (swept.ps === undefined) {
          console.warn(
            `pool-chaos (${kind}): \`ps\` cannot run here; only the kill(-pgid, 0) probe swept the group`,
          )
        } else {
          assert.deepEqual(swept.ps, [], 'ps: no process of the group is left')
        }
      } finally {
        killGroup(run.pgid)
      }
    })
  })
}
