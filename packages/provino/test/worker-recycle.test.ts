// T9.5: Jest's `workerIdleMemoryLimit` mapped onto the pool's recycle policy, checked against
// jest-worker 30.5.1 itself (a real `Worker` with the same `idleMemoryLimit` restarts its child, or
// doesn't, exactly where `workerRecycle` says a worker holding a typical amount would be
// replaced). The strings Jest accepts (`'512MB'`, `'50%'`, `0.2`) are turned into this number by
// jest-config's `stringToBytes`, which the Jest dialect's config reader rebuilds and checks
// against jest-config (`dialect-jest`'s `normalize.test.ts`).
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { totalmem } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { isRunning } from './support.ts'

/**
 * `workerRecycle`, loaded by URL: the type-test project includes this directory but not the
 * package's source.
 */
const { workerRecycle } = (await import(
  new URL('../src/internal/jest-command.ts', import.meta.url).href
)) as {
  workerRecycle(
    limit: number | undefined,
    totalMemory?: number,
  ): { readonly recycle?: { readonly memoryLimitBytes: number } }
}

/** What `new Worker(file, options)` gives, as far as this test uses it. */
interface JestWorker {
  pid(): Promise<number>
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

  it('reads a number as jest-worker does: 0 is every file, (0, 1] a share of the memory, else bytes', () => {
    assert.deepEqual(workerRecycle(0), { recycle: { memoryLimitBytes: 0 } })
    assert.deepEqual(workerRecycle(0.5, 1000), { recycle: { memoryLimitBytes: 500 } })
    assert.deepEqual(workerRecycle(1, 1000), { recycle: { memoryLimitBytes: 1000 } })
    assert.deepEqual(workerRecycle(0.2, 1001), { recycle: { memoryLimitBytes: 200 } })
    assert.deepEqual(workerRecycle(1.5), { recycle: { memoryLimitBytes: 1 } })
    assert.deepEqual(workerRecycle(536_870_912), { recycle: { memoryLimitBytes: 536_870_912 } })
    assert.deepEqual(workerRecycle(536_870_912.7), { recycle: { memoryLimitBytes: 536_870_912 } })
  })

  it('reads a share that floors to 0 bytes as no limit, as jest-worker does, not as every file', () => {
    // jest-worker restarts on `limit && heapUsed > limit` after flooring: 0 there is "never".
    assert.deepEqual(workerRecycle(1e-9, 1000), {
      recycle: { memoryLimitBytes: Number.POSITIVE_INFINITY },
    })
    assert.deepEqual(workerRecycle(0.0009, 1000), {
      recycle: { memoryLimitBytes: Number.POSITIVE_INFINITY },
    })
    // Only a limit of 0 itself is every file; one that floors to 1 byte still replaces.
    assert.deepEqual(workerRecycle(0), { recycle: { memoryLimitBytes: 0 } })
    assert.deepEqual(workerRecycle(0.001, 1000), { recycle: { memoryLimitBytes: 1 } })
  })
})

/** How long a restart that is due may take, on a machine as loaded as it gets. */
const RESTART_DEADLINE_MS = 30_000
/** How long a child that is not to be restarted is watched for. */
const NO_RESTART_SETTLE_MS = 1500

describe('against jest-worker 30.5.1', () => {
  let dir: string
  let file: string
  const made: Promise<void> = mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'provino-jw-')).then(
    async (path) => {
      dir = path
      file = join(path, 'worker.cjs')
      await writeFile(file, 'exports.pid = () => process.pid\n')
    },
  )
  after(async () => {
    await made
    await rm(dir, { recursive: true, force: true })
  })

  /**
   * Whether jest-worker replaces its child after one call with this limit. The check is a message
   * to the child and back, and a restart an asynchronous kill of the old child, after the call has
   * ended: how long that takes is the machine's to say. So when a restart is expected the old
   * child is waited for until it is gone, with a deadline far past anything a loaded machine
   * needs. When none is expected there is nothing to observe, and the child gets a bounded time to
   * show that it is not killed: a slow machine can only make that assertion weaker, never fail it.
   */
  async function restarts(limit: number, expected: boolean): Promise<boolean> {
    await made
    const Worker = jestWorker()
    const worker = new Worker(file, {
      numWorkers: 1,
      enableWorkerThreads: false,
      idleMemoryLimit: limit,
      exposedMethods: ['pid'],
    })
    try {
      const first = await worker.pid()
      const until = Date.now() + (expected ? RESTART_DEADLINE_MS : NO_RESTART_SETTLE_MS)
      while (isRunning(first)) {
        if (Date.now() > until) return false
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      return true
    } finally {
      await worker.end()
    }
  }

  /** What the pool does for a worker holding `heapBytes` after a file, under `limit`. */
  function poolReplaces(limit: number, heapBytes: number): boolean {
    const recycle = workerRecycle(limit).recycle
    return recycle !== undefined && heapBytes > recycle.memoryLimitBytes
  }

  // A child that has just started holds a few MB of heap: the cases are far from that figure.
  const HEAP = 8 * 1024 * 1024
  const total = totalmem()
  const cases: readonly [name: string, limit: number][] = [
    ['0: after every file', 0],
    ['a few KB', 5000],
    ['a tiny share of the memory (1e-7)', 1e-7],
    ['a share that is a quarter of a child’s heap', HEAP / 4 / total],
    ['a share that is a hundred times its heap', (HEAP * 100) / total],
    ['half the memory', 0.5],
    ['all of it (1)', 1],
    ['a terabyte', 1e12],
    // Floors to 0 bytes: jest-worker never restarts (the pool must not read it as 0, every file).
    ['a share that floors to 0 bytes (1e-15)', 1e-15],
  ]
  for (const [name, limit] of cases) {
    it(`${name}: restarts where the pool replaces`, async () => {
      const replaces = poolReplaces(limit, HEAP)
      assert.equal(await restarts(limit, replaces), replaces, `limit ${limit}`)
    })
  }
})
