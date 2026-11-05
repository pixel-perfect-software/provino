import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { NormalizedRun, SerializedError } from '@provino/types'
import { createReporterBus } from '../bus.ts'
import {
  breadthFirst,
  buildFile,
  collectedEvent,
  error,
  FIXED_ENV,
  type FileSpec,
  fileInfo,
  type Output,
  output,
  playRun,
  resultOf,
  taskId,
  taskResult,
  testEndEvent,
  unhandledEvent,
} from '../internal/test-support.ts'
import { buildNormalizedRun, type FileRecord, newFileRecord, testsInOrder } from './build.ts'
import { normalizedJsonReporter } from './reporter.ts'

const STARTED_AT_MS = Date.UTC(2026, 10, 5, 12, 0, 0)

/** Runs `files` through the reporter and returns what it wrote, parsed. */
async function write(
  files: readonly FileSpec[],
  options: {
    readonly unhandled?: readonly SerializedError[]
  } = {},
): Promise<NormalizedRun> {
  const out = output()
  const bus = createReporterBus([reporter(out)])
  await playRun(bus, files, options.unhandled === undefined ? {} : { unhandled: options.unhandled })
  assert.deepEqual(bus.failures(), [])
  return parse(out)
}

function reporter(out: Output) {
  return normalizedJsonReporter({
    stream: out,
    suite: 'suite@1',
    runner: 'provino:test',
    runnerVersion: '0.0.0',
    env: FIXED_ENV,
    now: () => STARTED_AT_MS,
  })
}

/** The reporter's own output is the thing under test, so the parsed value is typed by assertion. */
function parseText(text: string): NormalizedRun {
  return JSON.parse(text) as NormalizedRun
}

function parse(out: Output): NormalizedRun {
  return parseText(out.text())
}

describe('the normalized-json reporter', () => {
  test('writes one NormalizedRun, whole', async () => {
    const run = await write([
      {
        path: 'src/a.test.ts',
        durationMs: 12,
        tests: [
          { path: ['adds'], durationMs: 2, passingAssertions: 3 },
          { path: ['group', 'subtracts'], durationMs: 1 },
        ],
      },
    ])
    assert.deepEqual(run, {
      schemaVersion: 1,
      runner: 'provino:test',
      runnerVersion: '0.0.0',
      suite: 'suite@1',
      startedAt: '2026-11-05T12:00:00.000Z',
      env: FIXED_ENV,
      files: [
        {
          file: 'src/a.test.ts',
          status: 'passed',
          tests: [
            {
              id: { file: 'src/a.test.ts', path: ['adds'], dupIndex: 0 },
              status: 'passed',
              errors: [],
              passingAssertions: 3,
              durationMs: 2,
            },
            {
              id: { file: 'src/a.test.ts', path: ['group', 'subtracts'], dupIndex: 0 },
              status: 'passed',
              errors: [],
              passingAssertions: 0,
              durationMs: 1,
            },
          ],
          durationMs: 12,
        },
      ],
      runErrors: [],
      success: true,
    })
  })

  test('leaves out snapshots, console and trace: they are T12.16’s', async () => {
    const run = await write([{ path: 'a.test.ts', tests: [{ path: ['t'] }] }])
    assert.equal('snapshots' in run, false)
    assert.equal('console' in (run.files[0] ?? {}), false)
    assert.equal('trace' in (run.files[0] ?? {}), false)
  })

  test('sorts files by path in code-point order, whatever order they finished in', async () => {
    const run = await write([
      { path: 'b/z.test.ts' },
      { path: 'a/y.test.ts' },
      { path: 'B/x.test.ts' },
      { path: 'a/x.test.ts' },
    ])
    assert.deepEqual(
      run.files.map((file) => file.file),
      ['B/x.test.ts', 'a/x.test.ts', 'a/y.test.ts', 'b/z.test.ts'],
    )
  })

  test('lists tests in collection order, with the dupIndex of tests sharing a full name', async () => {
    const run = await write([
      {
        path: 'dup.test.ts',
        tests: [
          { path: ['same'] },
          { path: ['suite', 'inner'] },
          { path: ['suite', 'inner'] },
          { path: ['same'], state: 'fail', errors: [error('second one failed')] },
          { path: ['other'] },
        ],
      },
    ])
    assert.deepEqual(
      run.files[0]?.tests.map((test) => [...test.id.path, test.id.dupIndex, test.status]),
      [
        ['same', 0, 'passed'],
        ['suite', 'inner', 0, 'passed'],
        ['suite', 'inner', 1, 'passed'],
        ['same', 1, 'failed'],
        ['other', 0, 'passed'],
      ],
    )
  })

  test('reads declaration order from the tree, not from the order of the task array', async () => {
    const file = buildFile({
      path: 'tree.test.ts',
      tests: [{ path: ['deep', 'first'] }, { path: ['deep', 'third'] }, { path: ['second'] }],
    })
    const shuffled = breadthFirst(file.tasks)
    const arrayOrder = shuffled.flatMap((task) => (task.type === 'test' ? [task.fullName] : []))
    assert.deepEqual(arrayOrder[0], ['second'], 'the array puts the shallow test first')
    assert.deepEqual(
      testsInOrder(shuffled).map((test) => test.fullName),
      [['deep', 'first'], ['deep', 'third'], ['second']],
    )
  })

  test('adds the tests the walk from the file node never reaches, in array order', () => {
    const file = buildFile({ path: 'odd.test.ts', tests: [{ path: ['a'] }, { path: ['b'] }] })
    const unlinked = file.tasks.map((task) =>
      task.type === 'file' ? { ...task, children: [] } : task,
    )
    assert.deepEqual(
      testsInOrder(unlinked).map((test) => test.fullName),
      [['a'], ['b']],
    )
  })

  describe('a test', () => {
    test('maps each state, with its skip reason, retries, location and expect-fail flag', async () => {
      const run = await write([
        {
          path: 'states.test.ts',
          tests: [
            { path: ['pass'], state: 'pass', attempts: 3, location: { line: 4, column: 3 } },
            { path: ['fail'], state: 'fail', errors: [error('nope')], expectFail: true },
            { path: ['skip'], state: 'skip', skipReason: 'modifier' },
            { path: ['todo'], state: 'todo' },
          ],
        },
      ])
      const tests = run.files[0]?.tests ?? []
      assert.deepEqual(
        tests.map((test) => test.status),
        ['passed', 'failed', 'skipped', 'todo'],
      )
      assert.equal(tests[0]?.retries, 2)
      assert.deepEqual(tests[0]?.location, { line: 4, column: 3 })
      assert.equal(tests[1]?.expectedToFail, true)
      assert.equal(tests[2]?.skipReason, 'modifier')
      for (const test of [tests[1], tests[2], tests[3]])
        assert.equal('retries' in (test ?? {}), false)
      for (const test of [tests[0], tests[2], tests[3]]) {
        assert.equal('expectedToFail' in (test ?? {}), false)
      }
    })

    test('has the error’s name, message without ANSI, matcher and raw text', async () => {
      const run = await write([
        {
          path: 'errors.test.ts',
          tests: [
            {
              path: ['t'],
              state: 'fail',
              errors: [
                error('\u001b[31mexpected\u001b[39m 1', {
                  name: 'JestAssertionError',
                  stack: 'JestAssertionError: expected 1\n    at x (y.ts:1:1)',
                  matcherResult: { name: 'toBe', pass: false },
                }),
                error('plain', { name: '' }),
              ],
            },
          ],
        },
      ])
      assert.deepEqual(run.files[0]?.tests[0]?.errors, [
        {
          name: 'JestAssertionError',
          message: 'expected 1',
          matcher: 'toBe',
          raw: 'JestAssertionError: expected 1\n    at x (y.ts:1:1)',
        },
        { message: 'plain', raw: 'plain' },
      ])
    })

    test('collected but never ended is notRun, with nothing a run would have measured', async () => {
      const run = await write([
        {
          path: 'cut.test.ts',
          state: 'fail',
          errors: [error('stopped early')],
          tests: [{ path: ['ended'] }, { path: ['never'], ran: false }],
        },
      ])
      const [ended, never] = run.files[0]?.tests ?? []
      assert.equal(ended?.status, 'passed')
      assert.deepEqual(never, {
        id: { file: 'cut.test.ts', path: ['never'], dupIndex: 0 },
        status: 'notRun',
        errors: [],
      })
    })

    test('ended while still running or queued is notRun', async () => {
      const file = buildFile({ path: 'limbo.test.ts', tests: [{ path: ['t'] }, { path: ['u'] }] })
      const [queued, running] = file.tests
      assert.ok(queued && running)
      const out = output()
      const bus = createReporterBus([reporter(out)])
      await bus.emit('run:start', { root: '/', projects: [''], startTime: 0, watch: false }, [])
      await bus.emit('file:collected', file.info, collectedEvent(file))
      await bus.emit('task:end', queued.task, testEndEvent(queued.task, taskResult('queued')))
      await bus.emit('task:end', running.task, testEndEvent(running.task, taskResult('running')))
      await bus.emit('file:end', file.result)
      await bus.emit('run:end', {
        reason: 'passed',
        files: [file.result],
        unhandled: [],
        durationMs: 1,
      })
      assert.deepEqual(
        parse(out).files[0]?.tests.map((test) => test.status),
        ['notRun', 'notRun'],
      )
    })

    test('a test that ended with no file:collected is still listed', async () => {
      const file = buildFile({ path: 'late.test.ts', tests: [{ path: ['t'] }] })
      const [only] = file.tests
      assert.ok(only)
      const out = output()
      const bus = createReporterBus([reporter(out)])
      await bus.emit('run:start', { root: '/', projects: [''], startTime: 0, watch: false }, [])
      await bus.emit('task:end', only.task, testEndEvent(only.task, resultOf({ path: ['t'] })))
      await bus.emit('file:end', file.result)
      await bus.emit('run:end', {
        reason: 'passed',
        files: [file.result],
        unhandled: [],
        durationMs: 1,
      })
      assert.deepEqual(
        parse(out).files[0]?.tests.map((test) => test.id.path),
        [['t']],
      )
    })
  })

  describe('a file', () => {
    test('whose worker died is crashed, with the cause as its error', async () => {
      const run = await write([
        {
          path: 'segfault.test.ts',
          state: 'fail',
          workerExit: { type: 'signal', signal: 'SIGSEGV', likelyOom: false },
          errors: [
            error('the worker was killed by SIGSEGV', {
              name: 'WorkerCrash',
              stack: 'WorkerCrash: the worker was killed by SIGSEGV',
            }),
          ],
          tests: [{ path: ['finished'] }, { path: ['running when it died'], ran: false }],
        },
        { path: 'fine.test.ts', tests: [{ path: ['t'] }] },
      ])
      const [fine, crashed] = run.files
      assert.equal(crashed?.status, 'crashed')
      assert.deepEqual(crashed?.fileError, {
        name: 'WorkerCrash',
        message: 'the worker was killed by SIGSEGV',
        raw: 'WorkerCrash: the worker was killed by SIGSEGV',
      })
      assert.deepEqual(
        crashed?.tests.map((test) => test.status),
        ['passed', 'notRun'],
      )
      assert.equal(fine?.status, 'passed')
      assert.equal(run.success, false)
    })

    test('that failed with no tests is crashed (a collection error)', async () => {
      const run = await write([
        {
          path: 'syntax.test.ts',
          state: 'fail',
          errors: [error('Unexpected token', { name: 'SyntaxError' })],
        },
      ])
      assert.equal(run.files[0]?.status, 'crashed')
      assert.equal(run.files[0]?.fileError?.name, 'SyntaxError')
      assert.deepEqual(run.files[0]?.tests, [])
    })

    test('that failed with a failing test is failed, and has a fileError only for its own errors', async () => {
      const run = await write([
        {
          path: 'plain-fail.test.ts',
          tests: [{ path: ['t'], state: 'fail', errors: [error('the test failed')] }],
        },
        {
          path: 'after-all.test.ts',
          tests: [{ path: ['t'], state: 'fail', errors: [error('the test failed')] }],
          errors: [error('afterAll threw')],
        },
      ])
      const [afterAll, plain] = run.files
      assert.equal(plain?.status, 'failed')
      assert.equal('fileError' in (plain ?? {}), false)
      assert.equal(afterAll?.status, 'failed')
      assert.equal(afterAll?.fileError?.message, 'afterAll threw')
    })

    test('with several errors joins them into one fileError', async () => {
      const run = await write([
        {
          path: 'many.test.ts',
          state: 'fail',
          errors: [
            error('first', { name: 'TypeError', stack: 'TypeError: first\n    at a' }),
            error('second'),
          ],
        },
      ])
      assert.deepEqual(run.files[0]?.fileError, {
        name: 'TypeError',
        message: 'first\nsecond',
        raw: 'TypeError: first\n    at a\nsecond',
      })
    })

    test('that was skipped is skipped', async () => {
      const run = await write([
        { path: 'skip.test.ts', state: 'skip', tests: [{ path: ['t'], state: 'skip' }] },
      ])
      assert.equal(run.files[0]?.status, 'skipped')
      assert.equal(run.success, true)
    })

    test('carries the duration the runtime measured', async () => {
      const run = await write([{ path: 'time.test.ts', durationMs: 42 }])
      assert.equal(run.files[0]?.durationMs, 42)
    })
  })

  describe('unhandled and run-level errors', () => {
    async function withEvents(
      send: (bus: ReturnType<typeof createReporterBus>) => Promise<void>,
    ): Promise<NormalizedRun> {
      const out = output()
      const bus = createReporterBus([reporter(out)])
      const file = buildFile({ path: 'x.test.ts', tests: [{ path: ['t'] }] })
      await bus.emit('run:start', { root: '/', projects: [''], startTime: 0, watch: false }, [])
      await bus.emit('file:collected', file.info, collectedEvent(file))
      const test = file.tests[0]
      assert.ok(test)
      await bus.emit('task:end', test.task, testEndEvent(test.task, resultOf({ path: ['t'] })))
      await send(bus)
      await bus.emit('file:end', file.result)
      await bus.emit('run:end', {
        reason: 'passed',
        files: [file.result],
        unhandled: [],
        durationMs: 1,
      })
      return parse(out)
    }

    test('an unhandled error with no file is a run error, and fails the run', async () => {
      const run = await withEvents((bus) =>
        bus.emit('unhandled', null, unhandledEvent(error('stray rejection', { name: 'Error' }))),
      )
      assert.deepEqual(run.runErrors, [
        { name: 'Error', message: 'stray rejection', raw: 'stray rejection' },
      ])
      assert.equal(run.files[0]?.status, 'passed')
      assert.equal(run.success, false)
    })

    test('an error event, whatever its origin, is a run error', async () => {
      const run = await withEvents(async (bus) => {
        await bus.emit('error', error('from the coordinator'), 'coordinator')
        await bus.emit('error', error('from a reporter'), 'reporter')
        await bus.emit('error', error('from global setup'), 'globalSetup')
      })
      assert.deepEqual(
        run.runErrors.map((e) => e.message),
        ['from the coordinator', 'from a reporter', 'from global setup'],
      )
      assert.equal(run.success, false)
    })

    test('an unhandled error tied to a file fails that file, not the run’s errors', async () => {
      const file = fileInfo('x.test.ts')
      const run = await withEvents((bus) =>
        bus.emit('unhandled', file, unhandledEvent(error('late done'), taskId('x'))),
      )
      assert.deepEqual(run.runErrors, [])
      assert.equal(run.files[0]?.status, 'failed')
      assert.equal(run.files[0]?.fileError?.message, 'late done')
      assert.equal(run.success, false)
    })

    test('does not repeat an unhandled error the file’s own errors already hold', () => {
      const file = buildFile({
        path: 'twice.test.ts',
        state: 'fail',
        tests: [{ path: ['t'] }],
        errors: [error('afterAll threw')],
      })
      const record = newFileRecord()
      record.ended = file.result
      for (const { task } of file.tests) record.tests.set(task.id, task)
      record.unhandled.push(error('afterAll threw'), error('and a stray one'))
      const run = build(new Map([[file.info.fileId, record]]))
      assert.equal(run.files[0]?.fileError?.message, 'afterAll threw\nand a stray one')
    })
  })

  describe('success', () => {
    const FAILED_RUN: FileSpec = {
      path: 'f.test.ts',
      tests: [{ path: ['t'], state: 'fail', errors: [error('x')] }],
    }

    test('is true when every file passed or was skipped and nothing else went wrong', async () => {
      const run = await write([
        { path: 'a.test.ts', tests: [{ path: ['t'] }] },
        { path: 'b.test.ts', state: 'skip' },
      ])
      assert.equal(run.success, true)
    })

    test('is false for a failed file, a crashed file, and a run error', async () => {
      assert.equal((await write([FAILED_RUN])).success, false)
      assert.equal(
        (await write([{ path: 'c.test.ts', state: 'fail', errors: [error('x')] }])).success,
        false,
      )
    })

    test('is false for an interrupted run, even when every file that ran passed', async () => {
      const out = output()
      const bus = createReporterBus([reporter(out)])
      await bus.emit('run:start', { root: '/', projects: [''], startTime: 0, watch: false }, [])
      await bus.emit('run:end', { reason: 'interrupted', files: [], unhandled: [], durationMs: 1 })
      assert.equal(parse(out).success, false)
    })
  })

  describe('the model', () => {
    test('has no key whose value is undefined, in any file, test or error', () => {
      const file = buildFile({
        path: 'rich.test.ts',
        state: 'fail',
        durationMs: 9,
        errors: [error('file error', { name: 'Error' })],
        tests: [
          {
            path: ['a', 'b'],
            state: 'fail',
            attempts: 2,
            expectFail: true,
            location: { line: 1, column: 1 },
            errors: [error('x', { matcherResult: { name: 'toBe', pass: false }, stack: 's' })],
          },
          { path: ['c'], state: 'skip', skipReason: 'condition' },
          { path: ['d'], ran: false },
        ],
      })
      const record: FileRecord = newFileRecord()
      record.ended = file.result
      for (const { task, spec } of file.tests) {
        record.tests.set(task.id, task)
        if (spec.ran !== false) record.results.set(task.id, resultOf(spec))
      }
      const run = build(new Map([[file.info.fileId, record]]))
      const undefinedAt: string[] = []
      const walk = (value: unknown, path: string): void => {
        if (value === undefined) undefinedAt.push(path)
        else if (typeof value === 'object' && value !== null) {
          for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`)
        }
      }
      walk(run, 'run')
      assert.deepEqual(undefinedAt, [])
    })
  })

  describe('start and the environment', () => {
    test('takes startedAt from the clock at run:start', async () => {
      const times = [1_000, 2_000]
      const out = output()
      const bus = createReporterBus([
        normalizedJsonReporter({
          stream: out,
          suite: 's',
          runner: 'r',
          runnerVersion: '1',
          env: FIXED_ENV,
          now: () => times.shift() ?? 0,
        }),
      ])
      await playRun(bus, [])
      assert.equal(parse(out).startedAt, '1970-01-01T00:00:01.000Z')
    })

    test('reads the machine when none is given, with the runner’s version as provino’s', async () => {
      const out = output()
      const bus = createReporterBus([
        normalizedJsonReporter({
          stream: out,
          suite: 's',
          runner: 'provino:test',
          runnerVersion: '9.9.9',
        }),
      ])
      await playRun(bus, [])
      const { env } = parse(out)
      assert.deepEqual(env.runners, { provino: '9.9.9' })
      assert.equal(env.node, process.version)
      assert.equal(env.os, process.platform)
      assert.equal(typeof env.cpuModel, 'string')
      assert.ok(env.cpuCount >= 1)
      assert.ok(env.memoryMb > 0)
      assert.equal(typeof env.ci, 'boolean')
    })

    test('starts over at each run:start', async () => {
      const out = output()
      const bus = createReporterBus([reporter(out)])
      await playRun(bus, [{ path: 'first.test.ts' }])
      const afterFirst = out.text().length
      await bus.emit('error', error('between runs'), 'coordinator')
      await playRun(bus, [{ path: 'second.test.ts' }])
      const second = parseText(out.text().slice(afterFirst))
      assert.deepEqual(
        second.files.map((file) => file.file),
        ['second.test.ts'],
      )
      assert.deepEqual(second.runErrors, [])
    })
  })

  describe('output', () => {
    let dir: string
    before(async () => {
      dir = await mkdtemp(join(tmpdir(), 'provino-reporters-'))
    })
    after(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    test('goes to outputFile, creating its directory, and ends with a newline', async () => {
      const outputFile = join(dir, 'nested', 'deeper', 'run.json')
      const bus = createReporterBus([
        normalizedJsonReporter({
          outputFile,
          suite: 's',
          runner: 'r',
          runnerVersion: '1',
          env: FIXED_ENV,
        }),
      ])
      await playRun(bus, [{ path: 'a.test.ts', tests: [{ path: ['t'] }] }])
      assert.deepEqual(bus.failures(), [])
      const text = await readFile(outputFile, 'utf8')
      assert.ok(text.endsWith('}\n'))
      assert.equal(parseText(text).files[0]?.file, 'a.test.ts')
    })

    test('the file wins over the stream', async () => {
      const outputFile = join(dir, 'wins.json')
      const out = output()
      const bus = createReporterBus([
        normalizedJsonReporter({
          outputFile,
          stream: out,
          suite: 's',
          runner: 'r',
          runnerVersion: '1',
          env: FIXED_ENV,
        }),
      ])
      await playRun(bus, [])
      assert.equal(out.text(), '')
      assert.equal(parseText(await readFile(outputFile, 'utf8')).suite, 's')
    })

    test('a write that fails is a reporter failure, so the run fails', async () => {
      const blocker = join(dir, 'a-file')
      await writeFile(blocker, 'not a directory')
      const bus = createReporterBus([
        normalizedJsonReporter({
          outputFile: join(blocker, 'run.json'),
          suite: 's',
          runner: 'r',
          runnerVersion: '1',
          env: FIXED_ENV,
        }),
      ])
      await playRun(bus, [])
      const [failure] = bus.failures()
      assert.ok(failure)
      assert.match(failure.code ?? '', /ENOTDIR|EEXIST/)
    })

    test('a stream that rejects is a reporter failure too', async () => {
      const bus = createReporterBus([
        normalizedJsonReporter({
          stream: {
            write: () => Promise.reject(new Error('pipe closed')),
          },
          suite: 's',
          runner: 'r',
          runnerVersion: '1',
          env: FIXED_ENV,
        }),
      ])
      await playRun(bus, [])
      assert.deepEqual(
        bus.failures().map((failure) => failure.message),
        ['pipe closed'],
      )
    })
  })
})

/** `buildNormalizedRun` with the fixed identity every test here shares. */
function build(files: ReadonlyMap<ReturnType<typeof taskId>, FileRecord>): NormalizedRun {
  return buildNormalizedRun({
    runner: 'provino:test',
    runnerVersion: '0.0.0',
    suite: 'suite@1',
    startedAt: '2026-11-05T12:00:00.000Z',
    env: FIXED_ENV,
    files,
    runErrors: [],
    reason: 'failed',
  })
}
