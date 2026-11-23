// T9.5: Jest's `workerIdleMemoryLimit` mapped onto the pool's recycle policy, end to end. What a
// config says (`'512MB'`, `'50%'`, `0.2`, `0`) goes through the Jest dialect's config reader, which
// rebuilds jest-config's `stringToBytes`, as `provino jest` reads it. The number that comes out is
// what jest-runner gives a real jest-worker 30.5.1 `Worker` as `idleMemoryLimit`, and what
// `workerRecycle` maps: the worker restarts its child exactly where the pool would replace a worker
// that holds a typical amount.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { totalmem } from 'node:os'
import { describe, it } from 'provino'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createJestConfigReader, jestCli } from '@provino/dialect-jest/node'
import type { ConfigSource } from '@provino/types'
import { run } from 'provino/node'
import { Collect, isRunning, notedPids, noting, QUIET_ENV, trackedProjects } from './support.ts'

const makeProject = trackedProjects()

/**
 * `workerRecycle`, loaded by URL: the type-test project includes this directory but not the
 * package's source.
 */
const { workerRecycle } = (await import(
  new URL('../src/internal/jest-command.ts', import.meta.url).href
)) as {
  workerRecycle(limit: number | undefined): {
    readonly recycle?: { readonly memoryLimitBytes: number }
  }
}

/** What `new Worker(file, options)` gives, as far as this test uses it. */
interface JestWorker {
  pid(): Promise<number>
  holdHeap(): Promise<number>
  holdNative(): Promise<number>
  makeGarbage(): Promise<number>
  end(): Promise<unknown>
}

/** jest-worker, from the Jest the harness installs: jest, jest-cli, @jest/core, jest-runner, then it. */
function jestWorker(): new (file: string, options: object) => JestWorker {
  let from = createRequire(fileURLToPath(new URL('../../harness/package.json', import.meta.url)))
  for (const name of ['jest', 'jest-cli', '@jest/core', 'jest-runner']) {
    from = createRequire(from.resolve(name))
  }
  return (from('jest-worker') as { Worker: new (file: string, options: object) => JestWorker })
    .Worker
}

describe('workerRecycle', () => {
  it('gives the pool’s default when the config has no limit', () => {
    assert.deepEqual(workerRecycle(undefined), {})
  })

  it('takes the reader’s number as it is: 0 is every file, any other a count of bytes', () => {
    assert.deepEqual(workerRecycle(0), { recycle: { memoryLimitBytes: 0 } })
    assert.deepEqual(workerRecycle(5000), { recycle: { memoryLimitBytes: 5000 } })
    assert.deepEqual(workerRecycle(536_870_912), { recycle: { memoryLimitBytes: 536_870_912 } })
  })
})

/** How long a restart that is due may take, on a machine as loaded as it gets. */
const RESTART_DEADLINE_MS = 30_000
/** How long a child that is not to be restarted is watched for. */
const NO_RESTART_SETTLE_MS = 1500

/** Polls until the process `pid` is gone; false when `deadlineMs` passes first. */
async function goneWithin(pid: number, deadlineMs: number): Promise<boolean> {
  const until = Date.now() + deadlineMs
  while (isRunning(pid)) {
    if (Date.now() > until) return false
    await sleep(25)
  }
  return true
}

describe('against jest-worker 30.5.1', () => {
  /** The `workerIdleMemoryLimit` the Jest dialect's reader makes of a config's value, as `provino jest` reads it. */
  async function normalized(option: unknown): Promise<number | undefined> {
    const project = await makeProject({})
    const reader = createJestConfigReader({ argv: jestCli.parse([]).argv, cwd: project.dir })
    const source: ConfigSource = {
      kind: 'inline',
      path: project.dir,
      text: JSON.stringify({ workerIdleMemoryLimit: option }),
    }
    const resolved = await reader.resolve(await reader.load(source), source)
    return resolved.value.globalConfig.workerIdleMemoryLimit
  }

  /**
   * Whether jest-worker replaces its child after one call with this limit. The check is a message
   * to the child and back, and a restart an asynchronous kill of the old child, after the call has
   * ended: how long that takes is the machine's to say. So when a restart is expected the old
   * child is waited for until it is gone, with a deadline far past anything a loaded machine
   * needs. When none is expected there is nothing to observe, and the child gets a bounded time to
   * show that it is not killed: a slow machine can only make that assertion weaker, never fail it.
   */
  async function restarts(limit: number | undefined, expected: boolean): Promise<boolean> {
    const project = await makeProject({ 'worker.cjs': 'exports.pid = () => process.pid\n' })
    const Worker = jestWorker()
    // As jest-runner builds it: the normalized number, or none.
    const worker = new Worker(project.path('worker.cjs'), {
      numWorkers: 1,
      enableWorkerThreads: false,
      idleMemoryLimit: typeof limit === 'number' ? limit : undefined,
      exposedMethods: ['pid'],
    })
    try {
      const first = await worker.pid()
      return await goneWithin(first, expected ? RESTART_DEADLINE_MS : NO_RESTART_SETTLE_MS)
    } finally {
      await worker.end()
    }
  }

  /**
   * What the pool does for a worker holding `heapBytes` after a file, under the limit `provino jest`
   * maps. The heaps here are live ones (what a child holds before it has done anything), which the
   * worker's one collection before it reports leaves as they are: a heap that is only garbage is the
   * divergence below.
   */
  function poolReplaces(limit: number | undefined, heapBytes: number): boolean {
    const recycle = workerRecycle(limit).recycle
    return recycle !== undefined && heapBytes > recycle.memoryLimitBytes
  }

  // A child that has just started holds a few MB of heap: the cases are far from that figure.
  const HEAP = 8 * 1024 * 1024
  const total = totalmem()
  const cases: readonly [name: string, option: number | string][] = [
    ['0: after every file', 0],
    ['a few KB', 5000],
    ['a tiny share of the memory (1e-7)', 1e-7],
    ['a share that is a quarter of a child’s heap', HEAP / 4 / total],
    ['a share that is a hundred times its heap', (HEAP * 100) / total],
    ['half the memory', 0.5],
    ['all of it (1)', 1],
    ['a terabyte', 1e12],
    // Jest's own examples (`multipleValidOptions(0.2, '50%')`) and a size with a unit.
    ['0.2, a share', 0.2],
    ['"50%"', '50%'],
    ['"512MB", more than a child holds', '512MB'],
    ['"1kb", less than a child holds', '1kb'],
    // The reader floors this share to 0 bytes, and jest-worker reads that 0 as "after every file":
    // not as "no limit", which is what the raw 1e-15 would be.
    ['a share that floors to 0 bytes (1e-15)', 1e-15],
  ]
  for (const [name, option] of cases) {
    it(`${name}: restarts where the pool replaces`, async () => {
      const limit = await normalized(option)
      const replaces = poolReplaces(limit, HEAP)
      assert.equal(await restarts(limit, replaces), replaces, `config ${option}, read as ${limit}`)
    })
  }

  it('reads a share that floors to 0 bytes as 0, and 0 as every file', async () => {
    const limit = await normalized(1e-15)
    assert.equal(limit, 0)
    assert.deepEqual(workerRecycle(limit), { recycle: { memoryLimitBytes: 0 } })
  })

  /**
   * What the child holds is what jest-worker compares: `process.memoryUsage().heapUsed`, so a
   * child that grows only native memory (a `Buffer` of 200 MB, which puts its RSS over the limit)
   * is kept, and one that grows its heap past the limit is replaced. The pool measures the same
   * quantity in a fork (`worker-recycle` in `packages/orchestrator/test/pool-chaos.test.ts`),
   * after one collection when it is over the limit: the two differ for garbage alone (below).
   */
  for (const [name, method, expected] of [
    ['a child that grows only native memory', 'holdNative', false],
    ['a child that grows its heap past the limit', 'holdHeap', true],
  ] as const) {
    it(`${name}: ${expected ? 'restarts' : 'is kept'}, as the pool's heapUsed comparison`, async () => {
      const project = await makeProject({
        'worker.cjs': [
          'const held = []',
          'exports.pid = () => process.pid',
          'exports.holdHeap = () => { held.push(new Array(20_000_000).fill(1)); return process.pid }',
          'exports.holdNative = () => { held.push(Buffer.alloc(200 * 1024 * 1024, 1)); return process.pid }',
          '',
        ].join('\n'),
      })
      const Worker = jestWorker()
      const worker = new Worker(project.path('worker.cjs'), {
        numWorkers: 1,
        enableWorkerThreads: false,
        idleMemoryLimit: 100 * 1024 * 1024,
        exposedMethods: ['pid', 'holdHeap', 'holdNative'],
      })
      try {
        const first = await worker[method]()
        await goneWithin(first, expected ? RESTART_DEADLINE_MS : NO_RESTART_SETTLE_MS)
        assert.equal(!isRunning(first), expected)
      } finally {
        await worker.end()
      }
    })
  }
})

// DIVERGENCES: collect before recycling (Tyler 2026-11-16, speed, D115). jest-worker compares the
// child's `heapUsed` as it is, garbage included, so a child that has only made garbage is replaced.
// The pool asks the worker to collect once when its heap is over the limit and replaces it only if
// it is still over: a replacement reloads every shared module for nothing. A test can't tell:
// `JEST_WORKER_ID` and the files a worker runs are the same either way. Everything above is the
// same in both; this is the whole difference (a worker that holds what it made is replaced by
// both: `pool-chaos.test.ts` in the orchestrator).
describe('garbage alone: a deliberate difference from jest-worker 30.5.1', () => {
  /** 240 MB of heap, nothing refers to it once the expression is done. */
  const GARBAGE = 'new Array(30_000_000).fill(0)'
  /** Over a bare child's heap and under what the garbage adds to it, with room on both sides. */
  const LIMIT = 200 * 1024 * 1024

  it('jest-worker replaces a child that only made garbage: it reads heapUsed as it is', async () => {
    const project = await makeProject({
      'worker.cjs': [
        'exports.pid = () => process.pid',
        `exports.makeGarbage = () => { ${GARBAGE}; return process.pid }`,
        '',
      ].join('\n'),
    })
    const Worker = jestWorker()
    const worker = new Worker(project.path('worker.cjs'), {
      numWorkers: 1,
      enableWorkerThreads: false,
      idleMemoryLimit: LIMIT,
      exposedMethods: ['pid', 'makeGarbage'],
    })
    try {
      const first = await worker.makeGarbage()
      assert.ok(
        await goneWithin(first, RESTART_DEADLINE_MS),
        'the child that made the garbage is still there',
      )
    } finally {
      await worker.end()
    }
  })

  it('the pool keeps its worker: it collects the garbage before it compares the heap with the limit', async () => {
    const project = await makeProject((dir) =>
      Object.fromEntries(
        ['a', 'b', 'c'].map((name) => [
          `tests/${name}.test.js`,
          noting(name, `${dir}/workers.pids`, [`  ${GARBAGE}`]),
        ]),
      ),
    )
    const stderr = new Collect()
    const result = await run({
      config: project.config,
      pool: 'forks',
      maxWorkers: 1,
      workerMemoryLimit: LIMIT,
      stdout: new Collect(),
      stderr,
      env: QUIET_ENV,
    })
    assert.equal(result.exitCode, 0, stderr.text)
    const pids = await notedPids(project.path('workers.pids'))
    assert.equal(pids.length, 3)
    assert.equal(new Set(pids).size, 1, `one worker took every file, got ${pids.join(', ')}`)
  })
})
