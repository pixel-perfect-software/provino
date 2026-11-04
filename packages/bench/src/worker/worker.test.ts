// B10's acceptance, as tests: app-500 in one inline worker under both tiers; a global set by file A
// is invisible to file B under `registry` (and visible under `none`), with the real node
// environment and the Jest dialect, over each transport; and each test's events arrive in order,
// for a file with concurrent tests, hooks, repeats, skips and console output.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Writable } from 'node:stream'
import { after, describe, it } from 'node:test'
import type { PoolKind, TaskId, WorkerEvent } from '@provino/types'
import { checkSuite, meetsBar, TIERS, writeJestSuite } from './check.ts'
import { fileIdOf, PROJECT_NAME, runWorkerFiles, type WorkerRunResult } from './run.ts'

const POOLS: readonly PoolKind[] = ['inline', 'threads', 'forks']

const cleanups: Array<() => Promise<void>> = []
after(async () => {
  await Promise.all(cleanups.map((cleanup) => cleanup()))
})

/** Writes `files` (name → text) into a new temporary directory. */
async function project(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'provino-worker-test-')))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), text)
  }
  return dir
}

/** What a worker printed to stderr, kept out of the test output. */
class Collect extends Writable {
  text = ''
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.text += chunk.toString()
    done()
  }
}

/** `test-end` states by test name, from the kept events. */
function statesOf(events: readonly WorkerEvent[]): Record<string, string> {
  const names = new Map<TaskId, string>()
  for (const event of events) {
    if (event.type !== 'file-collect-end') continue
    for (const task of event.tasks) if (task.type === 'test') names.set(task.id, task.name)
  }
  return Object.fromEntries(
    events.flatMap((event) =>
      event.type === 'test-end' ? [[names.get(event.id) ?? event.id, event.result.state]] : [],
    ),
  )
}

describe('app-500 in one inline worker', () => {
  it('runs all 4,000 tests passing under registry and under none, in order', async (t) => {
    const suite = await writeJestSuite('app-500')
    cleanups.push(suite.cleanup)
    const checks = await checkSuite(suite)
    assert.deepEqual(
      checks.map((check) => check.result.isolation),
      [...TIERS],
    )
    for (const { result, expected, ok } of checks) {
      t.diagnostic(`${result.isolation}: ${result.elapsedMs.toFixed(0)} ms (local)`)
      assert.deepEqual(result.failures, [], result.isolation)
      assert.deepEqual(result.violations, [], result.isolation)
      assert.equal(result.files, 500)
      assert.equal(result.passed, 4000, result.isolation)
      assert.equal(result.total, 4000, result.isolation)
      assert.equal(expected, 4000)
      assert.equal(ok, true)
    }
  })

  it('the bar fails a run with a failing test, an unhandled error or a violation', () => {
    const passing: WorkerRunResult = {
      pool: 'inline',
      isolation: 'registry',
      files: 1,
      passed: 8,
      failed: 0,
      skipped: 0,
      total: 8,
      violations: [],
      failures: [],
      unhandled: 0,
      elapsedMs: 1,
      events: [],
    }
    assert.equal(meetsBar(passing, 8), true)
    assert.equal(meetsBar({ ...passing, passed: 7, failed: 1 }, 8), false)
    assert.equal(meetsBar({ ...passing, passed: 7, skipped: 1 }, 8), false)
    assert.equal(meetsBar({ ...passing, unhandled: 1 }, 8), false)
    assert.equal(meetsBar({ ...passing, violations: ['x'] }, 8), false)
    assert.equal(meetsBar(passing, 9), false)
  })
})

describe('global isolation, with the real node environment and the Jest dialect', () => {
  const files = {
    'a.test.js': [
      "test('a leaks three things', () => {",
      '  globalThis.leak = 1',
      "  Object.defineProperty(globalThis, 'withGetter', { get: () => 2, configurable: true })",
      '  expect.extend({',
      '    toBeEven(received) { return { pass: received % 2 === 0, message: () => "not even" } },',
      '  })',
      '  expect(2).toBeEven()',
      '})',
    ].join('\n'),
    // File B checks that all three are absent (or, when `visible`, present).
    'b-absent.test.js': [
      "test('b sees none of them', () => {",
      '  expect(globalThis.leak).toBeUndefined()',
      "  expect(Object.getOwnPropertyDescriptor(globalThis, 'withGetter')).toBeUndefined()",
      "  expect(typeof expect(2).toBeEven).toBe('undefined')",
      "  expect(typeof expect.toBeEven).toBe('undefined')",
      "  expect(typeof expect.not.toBeEven).toBe('undefined')",
      '})',
    ].join('\n'),
    'b-present.test.js': [
      "test('b sees all of them', () => {",
      '  expect(globalThis.leak).toBe(1)',
      "  expect(typeof Object.getOwnPropertyDescriptor(globalThis, 'withGetter').get).toBe('function')",
      '  expect(2).toBeEven()',
      "  expect(typeof expect.toBeEven).toBe('function')",
      "  expect(typeof expect.not.toBeEven).toBe('function')",
      '})',
    ].join('\n'),
  }

  for (const pool of POOLS) {
    describe(`${pool} worker`, () => {
      const run = async (isolation: 'registry' | 'none', b: string) => {
        const dir = await project(files)
        return await runWorkerFiles({
          rootDir: dir,
          files: [join(dir, 'a.test.js'), join(dir, b)],
          pool,
          isolation,
          keepEvents: true,
          stderr: new Collect(),
        })
      }

      it('registry: file B sees no global, no getter and no custom matcher from file A', async () => {
        const result = await run('registry', 'b-absent.test.js')
        assert.deepEqual(result.failures, [])
        assert.deepEqual(result.violations, [])
        assert.deepEqual(statesOf(result.events), {
          'a leaks three things': 'pass',
          'b sees none of them': 'pass',
        })
      })

      it('registry: the same check fails if file B expects them, so it can tell', async () => {
        const result = await run('registry', 'b-present.test.js')
        assert.deepEqual(statesOf(result.events), {
          'a leaks three things': 'pass',
          'b sees all of them': 'fail',
        })
      })

      it('none: file B sees all three', async () => {
        const result = await run('none', 'b-present.test.js')
        assert.deepEqual(result.failures, [])
        assert.deepEqual(result.violations, [])
        assert.deepEqual(statesOf(result.events), {
          'a leaks three things': 'pass',
          'b sees all of them': 'pass',
        })
      })
    })
  }
})

describe('each test’s events arrive in order', () => {
  /** A file with concurrent tests, hooks, repeats, a failure, a skip, a todo and console output. */
  const ordering = (log: boolean): string => {
    const print = (text: string) => (log ? `console.log('${text}'); ` : '')
    return [
      "describe('ordering', () => {",
      `  beforeAll(() => { ${print('beforeAll')}})`,
      `  afterAll(() => { ${print('afterAll')}})`,
      `  beforeEach(() => { ${print('beforeEach')}})`,
      `  afterEach(() => { ${print('afterEach')}})`,
      `  test('plain', () => { ${print('plain')}expect(1).toBe(1) })`,
      `  test('failing', () => { ${print('failing')}expect(1).toBe(2) })`,
      `  test('repeated', { repeats: 2 }, () => { ${print('repeated')}expect(1).toBe(1) })`,
      "  describe('concurrent', () => {",
      `    test.concurrent('slow', async () => { ${print('slow start')}await new Promise((r) => setTimeout(r, 20)); ${print('slow end')}expect(1).toBe(1) })`,
      `    test.concurrent('quick', async () => { ${print('quick')}expect(2).toBe(2) })`,
      `    test.concurrent('middle', async () => { await new Promise((r) => setTimeout(r, 5)); ${print('middle')}expect(3).toBe(3) })`,
      '  })',
      "  test.skip('skipped', () => {})",
      "  test.todo('todo')",
      `  test('floating', () => { Promise.resolve().then(() => { ${print('late')}}) })`,
      '})',
    ].join('\n')
  }
  const second = "test('second file', () => { expect(true).toBe(true) })"
  const expected = {
    plain: 'pass',
    failing: 'fail',
    repeated: 'pass',
    slow: 'pass',
    quick: 'pass',
    middle: 'pass',
    skipped: 'skip',
    todo: 'todo',
    floating: 'pass',
    'second file': 'pass',
  }

  for (const pool of POOLS) {
    it(`${pool}: zero order violations, the expected statuses, and every event the job’s own`, async () => {
      // Inline workers share the coordinator’s stdio, so only the others log inside tests.
      const dir = await project({ 'a.test.js': ordering(pool !== 'inline'), 'b.test.js': second })
      const files = [join(dir, 'a.test.js'), join(dir, 'b.test.js')]
      const result = await runWorkerFiles({
        rootDir: dir,
        files,
        pool,
        keepEvents: true,
        stderr: new Collect(),
      })
      assert.deepEqual(result.violations, [])
      assert.deepEqual(statesOf(result.events), expected)
      // `failing` is the one failure; no unhandled error came with it.
      assert.equal(result.failed, 1)
      assert.equal(result.unhandled, 0)
      const ends = result.events.filter((event) => event.type === 'file-end')
      assert.deepEqual(
        ends.map((event) => event.fileId),
        files.map((file) => fileIdOf(PROJECT_NAME, dir, file)),
      )
      const logs = result.events.filter((event) => event.type === 'console')
      if (pool === 'inline') assert.equal(logs.length, 0)
      else {
        // Console output reaches the coordinator in order with the events around it.
        assert.ok(logs.length >= 10, `${logs.length} console events`)
        const lastLog = result.events.findLastIndex((event) => event.type === 'console')
        assert.ok(lastLog < result.events.findIndex((event) => event.type === 'file-end'))
      }
      // The repeats really ran as three attempts of one test.
      const attempts = result.events.filter((event) => event.type === 'test-attempt-end')
      const byTest = Map.groupBy(attempts, (event) => event.id)
      assert.ok([...byTest.values()].some((runs) => runs.length === 3))
    })
  }
})
