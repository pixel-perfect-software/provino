// T9.2's second check: Track 9 spike A2's isolation cases (`check-isolation.mjs`, rebuilt from the
// doc's table, L595-L608) map to the right WorkerExit. A native fault is modelled the way the spike
// did it, `process.kill(process.pid, 'SIGSEGV')`. The inline kind isn't here: nothing isolates it.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { connectWorker, transportFor, type WorkerConnection } from '@provino/orchestrator'
import type { PoolKind, RuntimeEventOf, WorkerEvent, WorkerExit } from '@provino/types'
import { Collect, fixture, initFor, job, methods } from './support.ts'

async function startIsolation(
  kind: 'forks' | 'threads',
  options: {
    readonly execArgv?: readonly string[]
    readonly memoryLimitMb?: number
    readonly env?: NodeJS.ProcessEnv
  } = {},
): Promise<{ connection: WorkerConnection; events: WorkerEvent[]; stderr: Collect }> {
  const stderr = new Collect()
  const events: WorkerEvent[] = []
  const transport = await transportFor(kind, {
    entry: fixture('isolation-worker.ts'),
    stderr,
    ...options,
  }).create(initFor(kind as PoolKind))
  const connection = connectWorker(transport, {
    methods,
    onEvents: (batch) => void events.push(...batch),
  })
  return { connection, events, stderr }
}

/** Runs one case on a fresh worker and returns how the worker ended. */
async function crash(
  kind: 'forks' | 'threads',
  file: string,
  options: Parameters<typeof startIsolation>[1] = {},
): Promise<{ exit: WorkerExit; stderr: string }> {
  const { connection, stderr } = await startIsolation(kind, options)
  await assert.rejects(connection.run(job(file)), { code: 'ORCH_WORKER_EXITED' })
  return { exit: await connection.exited, stderr: stderr.text }
}

/** Runs one case that leaves the worker alive and returns what it reported. */
async function observe(
  kind: 'forks' | 'threads',
  file: string,
  options: Parameters<typeof startIsolation>[1] = {},
): Promise<string> {
  const { connection, events } = await startIsolation(kind, options)
  await connection.run(job(file))
  await connection.transport.terminate(false)
  const notes = events.filter((e): e is RuntimeEventOf<'annotation'> => e.type === 'annotation')
  assert.equal(notes.length, 1)
  return (notes[0] as RuntimeEventOf<'annotation'>).message
}

describe('forks isolate the coordinator from the test file', () => {
  it('a native fault ends only the child: signal SIGSEGV, not OOM', async () => {
    const { exit } = await crash('forks', 'segfault')
    assert.deepEqual(exit, { type: 'signal', signal: 'SIGSEGV', likelyOom: false })
  })

  it("a heap OOM aborts the child, and V8's last words make it `oom` with the limit (T9.5)", async () => {
    const { exit, stderr } = await crash('forks', 'oom', {
      execArgv: [...process.execArgv, '--max-old-space-size=64'],
    })
    assert.deepEqual(exit, { type: 'oom', limitMb: 64 })
    assert.match(stderr, /heap out of memory/)
  })

  it('memoryLimitMb is the same limit, set by the transport', async () => {
    const { exit } = await crash('forks', 'oom', { memoryLimitMb: 48 })
    assert.deepEqual(exit, { type: 'oom', limitMb: 48 })
  })

  it('a heap OOM whose fatal error is followed by more than 8 KB of stderr is still `oom`', async () => {
    const { exit } = await crash('forks', 'oom-then-noise', { memoryLimitMb: 48 })
    assert.deepEqual(exit, { type: 'oom', limitMb: 48 })
  })

  it('a SIGABRT that is not out of memory stays a signal, likely OOM (no last words to read)', async () => {
    const { exit } = await crash('forks', 'abort')
    assert.deepEqual(exit, { type: 'signal', signal: 'SIGABRT', likelyOom: true })
  })

  it('process.exit(3) is exit code 3', async () => {
    assert.deepEqual((await crash('forks', 'exit3')).exit, { type: 'exit', code: 3 })
  })

  it('process.chdir works', async () => {
    assert.equal(await observe('forks', 'chdir'), 'ok')
  })

  it('setting process.env.TZ changes Date (UTC hour 0 becomes 9 in Tokyo)', async () => {
    assert.equal(await observe('forks', 'tz', { env: { ...process.env, TZ: 'UTC' } }), '9')
  })
})

describe('threads share the process', () => {
  it('a heap OOM over resourceLimits is `oom` with the limit', async () => {
    const { exit } = await crash('threads', 'oom', { memoryLimitMb: 64 })
    assert.deepEqual(exit, { type: 'oom', limitMb: 64 })
  })

  it('process.exit(3) ends the thread with code 3', async () => {
    assert.deepEqual((await crash('threads', 'exit3')).exit, { type: 'exit', code: 3 })
  })

  it('process.chdir throws ERR_WORKER_UNSUPPORTED_OPERATION', async () => {
    assert.equal(await observe('threads', 'chdir'), 'ERR_WORKER_UNSUPPORTED_OPERATION')
  })

  it('setting process.env.TZ leaves Date alone', async () => {
    assert.equal(await observe('threads', 'tz'), String(new Date(0).getHours()))
  })

  it('a native fault kills the whole coordinator by SIGSEGV', async () => {
    const child = spawn(
      process.execPath,
      [...process.execArgv, fileURLToPath(fixture('threads-segfault.ts'))],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.resume()
    const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null]
    assert.deepEqual({ code, signal }, { code: null, signal: 'SIGSEGV' })
    assert.doesNotMatch(stdout, /survived/)
  })
})
