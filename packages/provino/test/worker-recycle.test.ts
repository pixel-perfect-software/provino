// T9.5: Jest's `workerIdleMemoryLimit` mapped onto the pool's recycle policy, end to end. What a
// config says (`'512MB'`, `'50%'`, `0.2`, `0`) goes through the Jest dialect's config reader, which
// rebuilds jest-config's `stringToBytes`, as `provino jest` reads it. The number that comes out is
// what jest-runner gives a real jest-worker 30.5.1 `Worker` as `idleMemoryLimit`, and what
// `workerRecycle` maps: the worker restarts its child exactly where the pool would replace a worker
// that holds a typical amount.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { totalmem } from 'node:os'
import { describe, it } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createJestConfigReader, jestCli } from '@provino/dialect-jest/node'
import type { ConfigSource } from '@provino/types'
import { isRunning, trackedProjects } from './support.ts'

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
      const until = Date.now() + (expected ? RESTART_DEADLINE_MS : NO_RESTART_SETTLE_MS)
      while (isRunning(first)) {
        if (Date.now() > until) return false
        await sleep(25)
      }
      return true
    } finally {
      await worker.end()
    }
  }

  /** What the pool does for a worker holding `heapBytes` after a file, under the limit `provino jest` maps. */
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
})
