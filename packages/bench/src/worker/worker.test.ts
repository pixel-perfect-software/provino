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
import type { IsolationTier, PoolKind, TaskId, WorkerEvent } from '@provino/types'
import { checkSuite, meetsBar, TIERS, writeJestSuite } from './check.ts'
import { fileIdOf, PROJECT_NAME, runWorkerFiles, type WorkerRunResult } from './run.ts'

/** The throwing environment, as the absolute ref a worker imports it by. */
const THROWING_ENVIRONMENT = {
  module: import.meta.resolve('../internal/throwing-environment.ts'),
  export: 'throwingEnvironment',
  options: {},
} as const

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
      assert.equal(result.fileErrors, 0, result.isolation)
      assert.equal(result.leakedGlobals, 0, result.isolation)
      // An inline worker that stopped cleanly reports an exit with code 0.
      assert.deepEqual(result.exit, { type: 'exit', code: 0 }, result.isolation)
      assert.equal(ok, true)
    }
  })

  it('the bar fails a run with a failing test, an unhandled error, a file error, a leak, a violation or a bad exit', () => {
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
      fileErrors: 0,
      leakedGlobals: 0,
      exit: { type: 'exit', code: 0 },
      elapsedMs: 1,
      events: [],
    }
    assert.equal(meetsBar(passing, 8), true)
    assert.equal(meetsBar({ ...passing, passed: 7, failed: 1 }, 8), false)
    assert.equal(meetsBar({ ...passing, passed: 7, skipped: 1 }, 8), false)
    assert.equal(meetsBar({ ...passing, unhandled: 1 }, 8), false)
    assert.equal(meetsBar({ ...passing, fileErrors: 1 }, 8), false)
    assert.equal(meetsBar({ ...passing, leakedGlobals: 1 }, 8), false)
    assert.equal(meetsBar({ ...passing, violations: ['x'] }, 8), false)
    assert.equal(meetsBar(passing, 9), false)
    for (const exit of [
      { type: 'exit', code: 1 },
      { type: 'exit', code: 9 },
      { type: 'signal', signal: 'SIGKILL', likelyOom: false },
      { type: 'oom', limitMb: 512 },
      { type: 'timeout', phase: 'stop' },
    ] as const) {
      assert.equal(meetsBar({ ...passing, exit }, 8), false, JSON.stringify(exit))
    }
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

describe('a global the environment cannot remove (D22)', () => {
  // The file defines a global that can't be deleted. The node environment restores everything else
  // and reports the key instead of throwing: a warning to the coordinator, not a failure of the
  // file. A forked worker keeps the stuck global out of this process.
  const stuck = {
    'a.test.js': [
      "test('plants a global it cannot remove', () => {",
      "  Object.defineProperty(globalThis, '__provinoStuck', { value: 1, configurable: false })",
      '})',
    ].join('\n'),
  }

  it('registry: the file passes, the coordinator gets a warn naming the key, and fileDone lists it', async () => {
    const dir = await project(stuck)
    const result = await runWorkerFiles({
      rootDir: dir,
      files: [join(dir, 'a.test.js')],
      pool: 'forks',
      isolation: 'registry',
      keepEvents: true,
      stderr: new Collect(),
    })
    assert.deepEqual(statesOf(result.events), { 'plants a global it cannot remove': 'pass' })
    assert.equal(result.passed, 1)
    assert.equal(result.failed, 0)
    assert.equal(result.unhandled, 0, 'a warning, not an unhandled error')
    assert.equal(result.fileErrors, 0)
    assert.deepEqual(result.violations, [])
    assert.deepEqual(result.exit, { type: 'exit', code: 0 })

    const warnings = result.events.filter(
      (event) => event.type === 'console' && event.level === 'warn',
    )
    assert.equal(warnings.length, 1)
    const [warning] = warnings
    assert.ok(warning?.type === 'console')
    assert.equal(warning.taskId, null)
    assert.match(warning.text, /__provinoStuck/)
    assert.match(warning.text, /Later files in this worker can see it/)

    // fileDone.leakedGlobals: counted, and named in the failures the check prints.
    assert.equal(result.leakedGlobals, 1)
    assert.match(result.failures.join('\n'), /left globals behind: __provinoStuck/)
    // The leak alone fails the bar, though the worker called it a warning.
    assert.equal(meetsBar(result, 1), false)
    assert.equal(meetsBar({ ...result, leakedGlobals: 0 }, 1), true)
  })

  it('none: reported once, as a warn when the worker stops, with nothing on fileDone', async () => {
    const dir = await project(stuck)
    const result = await runWorkerFiles({
      rootDir: dir,
      files: [join(dir, 'a.test.js')],
      pool: 'forks',
      isolation: 'none',
      keepEvents: true,
      stderr: new Collect(),
    })
    assert.equal(result.passed, 1)
    assert.equal(result.unhandled, 0)
    assert.equal(
      result.leakedGlobals,
      0,
      'fileDone has nothing: the worker-scoped teardown ran at stop',
    )
    assert.deepEqual(result.exit, { type: 'exit', code: 0 })
    const warning = result.events.findLast((event) => event.type === 'console')
    assert.ok(warning?.type === 'console' && warning.level === 'warn')
    assert.match(warning.text, /when the worker stopped: __provinoStuck/)
    // It arrives after the last fileDone, but it is the teardown's, so it is not late output.
    assert.deepEqual(result.violations, [])
  })
})

describe('a failure while the worker stops', () => {
  // A teardown that throws is still a failure (decision D22 only turned an unremovable global
  // into a warning): after each file under `registry`, charged to that file, and only when the
  // worker stops under `none`, where the environment lives as long as the worker, with no owner.
  // The file defines nothing; the fixture environment's teardown throws.
  const quiet = { 'a.test.js': "test('does nothing', () => {})" }
  const run = async (isolation: IsolationTier) => {
    const dir = await project(quiet)
    return await runWorkerFiles({
      rootDir: dir,
      files: [join(dir, 'a.test.js')],
      environment: THROWING_ENVIRONMENT,
      pool: 'forks',
      isolation,
      keepEvents: true,
      stderr: new Collect(),
    })
  }

  for (const isolation of TIERS) {
    it(`${isolation}: the teardown’s unhandled error is counted, and the bar fails on it`, async () => {
      const result = await run(isolation)
      assert.deepEqual(statesOf(result.events), { 'does nothing': 'pass' })
      assert.equal(result.passed, 1)
      assert.equal(result.failed, 0)
      assert.equal(result.unhandled, 1)
      assert.equal(result.leakedGlobals, 0)
      assert.match(result.failures.join('\n'), /the environment’s teardown exploded/)
      if (isolation === 'none') assert.match(result.failures.join('\n'), /^stop: unhandled/m)
      assert.equal(meetsBar(result, 1), false)
      // The count alone fails the bar: it doesn't lean on the ordering checker noticing the event.
      assert.equal(meetsBar({ ...result, violations: [] }, 1), false)
    })
  }
})

describe('an error on the file itself', () => {
  it('a failing afterAll is counted, noted, and fails the bar though every test passed', async () => {
    const dir = await project({
      'a.test.js': [
        "afterAll(() => { throw new Error('afterAll blew up') })",
        "test('passes', () => { expect(1).toBe(1) })",
      ].join('\n'),
    })
    const result = await runWorkerFiles({ rootDir: dir, files: [join(dir, 'a.test.js')] })
    assert.equal(result.passed, 1)
    assert.equal(result.failed, 0)
    assert.equal(result.unhandled, 0)
    assert.equal(result.fileErrors, 1)
    assert.match(result.failures.join('\n'), /a\.test\.js: file failed: afterAll blew up/)
    assert.equal(meetsBar(result, 1), false)
    assert.equal(meetsBar({ ...result, fileErrors: 0 }, 1), true, 'it is the only thing wrong')
  })

  it('a file with no error counts none', async () => {
    const dir = await project({ 'a.test.js': "test('passes', () => {})" })
    const result = await runWorkerFiles({ rootDir: dir, files: [join(dir, 'a.test.js')] })
    assert.equal(result.fileErrors, 0)
    assert.equal(meetsBar(result, 1), true)
  })
})

describe('how the worker exits', () => {
  it('a fork that exits with a non-zero code fails the bar, though every test passed', async () => {
    const dir = await project({
      'a.test.js': [
        // The bootstrap exits on purpose with code 0; a handler for `exit` changes it.
        "process.on('exit', () => { process.exitCode = 9 })",
        "test('passes', () => { expect(1).toBe(1) })",
      ].join('\n'),
    })
    const result = await runWorkerFiles({
      rootDir: dir,
      files: [join(dir, 'a.test.js')],
      pool: 'forks',
      stderr: new Collect(),
    })
    assert.equal(result.passed, 1)
    assert.equal(result.failed, 0)
    assert.equal(result.unhandled, 0)
    assert.deepEqual(result.exit, { type: 'exit', code: 9 })
    assert.equal(meetsBar(result, 1), false)
    assert.equal(meetsBar({ ...result, exit: { type: 'exit', code: 0 } }, 1), true)
  })

  for (const pool of POOLS) {
    it(`${pool}: a clean worker exits with code 0`, async () => {
      const dir = await project({ 'a.test.js': "test('passes', () => {})" })
      const result = await runWorkerFiles({
        rootDir: dir,
        files: [join(dir, 'a.test.js')],
        pool,
        stderr: new Collect(),
      })
      assert.deepEqual(result.exit, { type: 'exit', code: 0 })
      assert.equal(meetsBar(result, 1), true)
    })
  }
})

describe('the Jest nesting ban, through the real loader', () => {
  it('isolateModules inside isolateModules throws Jest’s error; sequential use works', async () => {
    const dir = await project({
      'a.test.js': [
        "test('nested', () => {",
        '  jest.isolateModules(() => {',
        "    expect(() => jest.isolateModules(() => {})).toThrow('isolateModules cannot be nested inside another isolateModules or isolateModulesAsync.')",
        '  })',
        '  jest.isolateModules(() => {})',
        '})',
        "test('nested async', async () => {",
        '  await jest.isolateModulesAsync(async () => {',
        "    await expect(jest.isolateModulesAsync(async () => {})).rejects.toThrow('isolateModulesAsync cannot be nested inside another isolateModulesAsync or isolateModules.')",
        '  })',
        '  await jest.isolateModulesAsync(async () => {})',
        '})',
      ].join('\n'),
    })
    const result = await runWorkerFiles({
      rootDir: dir,
      files: [join(dir, 'a.test.js')],
      keepEvents: true,
    })
    assert.deepEqual(result.failures, [])
    assert.deepEqual(statesOf(result.events), { nested: 'pass', 'nested async': 'pass' })
  })
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
