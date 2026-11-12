import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ReportPolicy, SerializedError } from '@provino/types'
import { createReporterBus } from '../bus.ts'
import {
  buildFile,
  collectedEvent,
  error,
  type FileSpec,
  fileInfo,
  type Output,
  output,
  playRun,
  resultOf,
  taskId,
  testEndEvent,
  unhandledEvent,
} from '../internal/test-support.ts'
import { defaultReporter } from './reporter.ts'

/**
 * Jest's values for the `report` slice, as `jestPolicy` has them: the bullet is two spaces, `●`
 * and one space, as the `policy/report-default` golden records it.
 */
const JESTLIKE: ReportPolicy = {
  displaySeparator: ' › ',
  defaultReporters: ['default'],
  failureTitleBullet: '  ● ',
  resultStatusSkipped: 'pending',
}

const NEUTRAL: ReportPolicy = {
  displaySeparator: ' > ',
  defaultReporters: ['default'],
  failureTitleBullet: null,
  resultStatusSkipped: 'skipped',
}

async function report(
  files: readonly FileSpec[],
  options: {
    readonly policy?: ReportPolicy
    readonly unhandled?: readonly SerializedError[]
    readonly out?: Output
  } = {},
): Promise<string> {
  const out = options.out ?? output()
  const bus = createReporterBus([
    defaultReporter({ stream: out, report: options.policy ?? JESTLIKE }),
  ])
  await playRun(bus, files, options.unhandled === undefined ? {} : { unhandled: options.unhandled })
  assert.deepEqual(bus.failures(), [])
  return out.text()
}

const lines = (...text: string[]): string => `${text.join('\n')}\n`

describe('the default reporter', () => {
  test('prints a PASS line for each file and the totals', async () => {
    const text = await report([
      {
        path: 'a.test.ts',
        durationMs: 12,
        tests: [
          { path: ['one'] },
          { path: ['group', 'two'] },
          { path: ['three'], state: 'skip' },
          { path: ['four'], state: 'todo' },
        ],
      },
      { path: 'b.test.ts', durationMs: 3.4, tests: [{ path: ['five'] }] },
    ])
    assert.equal(
      text,
      lines(
        'PASS a.test.ts (12 ms)',
        'PASS b.test.ts (3 ms)',
        '',
        'Test Suites: 2 passed, 2 total',
        'Tests:       1 skipped, 1 todo, 3 passed, 5 total',
        'Time:        1.234 s',
      ),
    )
  })

  test('leaves zero parts out of the totals, except passed and total', async () => {
    const text = await report([{ path: 'empty.test.ts' }])
    assert.equal(
      text,
      lines(
        'PASS empty.test.ts (5 ms)',
        '',
        'Test Suites: 1 passed, 1 total',
        'Tests:       0 passed, 0 total',
        'Time:        1.234 s',
      ),
    )
  })

  test('prints a failed test under the policy’s bullet, with its message and stack', async () => {
    const text = await report([
      {
        path: 'c.test.ts',
        tests: [
          {
            path: ['math', 'adds'],
            state: 'fail',
            errors: [
              error('expected 2\nreceived 3', {
                stack:
                  'Error: expected 2\nreceived 3\n    at Object.<anonymous> (c.test.ts:5:10)\n    at run (runner.ts:1:1)',
              }),
            ],
          },
          { path: ['math', 'subtracts'] },
        ],
      },
    ])
    assert.equal(
      text,
      lines(
        'FAIL c.test.ts',
        '  ● math › adds',
        '',
        '    expected 2',
        '    received 3',
        '      at Object.<anonymous> (c.test.ts:5:10)',
        '      at run (runner.ts:1:1)',
        '',
        'Test Suites: 1 failed, 0 passed, 1 total',
        'Tests:       1 failed, 1 passed, 2 total',
        'Time:        1.234 s',
      ),
    )
  })

  test('joins a title with the policy’s separator, and indents it when there is no bullet', async () => {
    const text = await report(
      [
        {
          path: 'd.test.ts',
          tests: [{ path: ['outer', 'inner', 'case'], state: 'fail', errors: [error('nope')] }],
        },
      ],
      { policy: NEUTRAL },
    )
    assert.match(text, /^FAIL d\.test\.ts\n {2}outer > inner > case\n\n {4}nope\n/)
  })

  test('shows an error’s name unless the message already starts with it, and its message alone for Error', async () => {
    const text = await report([
      {
        path: 'names.test.ts',
        tests: [
          {
            path: ['a'],
            state: 'fail',
            errors: [error('x is not a function', { name: 'TypeError' })],
          },
          {
            path: ['b'],
            state: 'fail',
            errors: [error('TypeError: already prefixed', { name: 'TypeError' })],
          },
          { path: ['c'], state: 'fail', errors: [error('', { name: 'Timeout' })] },
        ],
      },
    ])
    assert.match(text, /\n {4}TypeError: x is not a function\n/)
    assert.match(text, /\n {4}TypeError: already prefixed\n/)
    assert.doesNotMatch(text, /TypeError: TypeError/)
    assert.match(text, /\n {4}Timeout\n/)
  })

  test('shows a cause and the errors an aggregate holds, nested', async () => {
    const text = await report([
      {
        path: 'nested.test.ts',
        tests: [
          {
            path: ['wrapped'],
            state: 'fail',
            errors: [
              error('outer', {
                cause: error('inner', { stack: 'Error: inner\n    at deep (x.ts:1:1)' }),
                errors: [error('first of many'), error('second of many')],
              }),
            ],
          },
        ],
      },
    ])
    assert.match(
      text,
      /\n {4}outer\n\n {4}Caused by:\n {6}inner\n {8}at deep \(x\.ts:1:1\)\n\n {4}Also:\n {6}first of many\n\n {4}Also:\n {6}second of many\n/,
    )
  })

  test('prints a file that failed to collect with its own errors', async () => {
    const text = await report([
      {
        path: 'broken.test.ts',
        state: 'fail',
        errors: [error("Cannot find module './missing.ts'", { name: 'ImportError' })],
      },
    ])
    assert.equal(
      text,
      lines(
        'FAIL broken.test.ts',
        '  ● Test suite failed to run',
        '',
        "    ImportError: Cannot find module './missing.ts'",
        '',
        'Test Suites: 1 failed, 0 passed, 1 total',
        'Tests:       0 passed, 0 total',
        'Time:        1.234 s',
      ),
    )
  })

  test('prints a crashed worker as the file’s error', async () => {
    const text = await report([
      {
        path: 'crash.test.ts',
        state: 'fail',
        workerExit: { type: 'signal', signal: 'SIGSEGV', likelyOom: false },
        errors: [error('the worker was killed by SIGSEGV', { name: 'WorkerCrash' })],
      },
      { path: 'fine.test.ts', tests: [{ path: ['ok'] }] },
    ])
    assert.match(
      text,
      /^FAIL crash\.test\.ts\n {2}● Test suite failed to run\n\n {4}WorkerCrash: the worker was killed by SIGSEGV\n\nPASS fine\.test\.ts/,
    )
    assert.match(text, /Test Suites: 1 failed, 1 passed, 2 total/)
  })

  test('prints a file’s own errors beside its failed tests, under another title', async () => {
    const text = await report([
      {
        path: 'both.test.ts',
        tests: [{ path: ['t'], state: 'fail', errors: [error('test failed')] }],
        errors: [error('afterAll failed')],
      },
    ])
    assert.match(
      text,
      / {2}● t\n\n {4}test failed\n\n {2}● Errors outside the tests\n\n {4}afterAll failed\n/,
    )
  })

  test('prints a skipped file and counts it', async () => {
    const text = await report([
      { path: 'skipped.test.ts', state: 'skip', tests: [{ path: ['t'], state: 'skip' }] },
      { path: 'ran.test.ts', tests: [{ path: ['t'] }] },
    ])
    assert.match(text, /^SKIP skipped\.test\.ts\nPASS ran\.test\.ts/)
    assert.match(text, /Test Suites: 1 skipped, 1 passed, 2 total/)
    assert.match(text, /Tests: {7}1 skipped, 1 passed, 2 total/)
  })

  test('counts only the tests that ended', async () => {
    const text = await report([
      {
        path: 'cut-short.test.ts',
        state: 'fail',
        errors: [error('stopped')],
        tests: [{ path: ['done'] }, { path: ['never'], ran: false }],
      },
    ])
    assert.match(text, /Tests: {7}1 passed, 1 total/)
  })

  test('prints unhandled errors from the summary before the totals', async () => {
    const text = await report([{ path: 'a.test.ts', tests: [{ path: ['t'] }] }], {
      unhandled: [error('unhandled boom', { name: 'RangeError' })],
    })
    assert.match(
      text,
      /PASS a\.test\.ts \(5 ms\)\n\n {2}● Unhandled error\n\n {4}RangeError: unhandled boom\n\nTest Suites:/,
    )
  })

  test('prints an error event where it happens, labelled by its origin', async () => {
    const out = output()
    const bus = createReporterBus([defaultReporter({ stream: out, report: JESTLIKE })])
    await bus.emit('error', error('config broke'), 'coordinator')
    await bus.emit('error', error('reporter broke'), 'reporter')
    await bus.emit('error', error('setup broke'), 'globalSetup')
    assert.equal(
      out.text(),
      lines(
        '  ● Run error',
        '',
        '    config broke',
        '',
        '  ● Reporter error',
        '',
        '    reporter broke',
        '',
        '  ● Global setup error',
        '',
        '    setup broke',
        '',
      ),
    )
  })

  test('starts its tallies over at each run:start', async () => {
    const out = output()
    const reporter = defaultReporter({ stream: out, report: JESTLIKE })
    const bus = createReporterBus([reporter])
    await playRun(bus, [{ path: 'first.test.ts', tests: [{ path: ['t'] }, { path: ['u'] }] }])
    const afterFirst = out.text().length
    await playRun(bus, [{ path: 'second.test.ts', tests: [{ path: ['t'] }] }])
    const second = out.text().slice(afterFirst)
    assert.match(second, /Test Suites: 1 passed, 1 total/)
    assert.match(second, /Tests: {7}1 passed, 1 total/)
  })

  test('does not report a test that failed an attempt and passed on retry', async () => {
    const text = await report([
      { path: 'retry.test.ts', tests: [{ path: ['flaky'], state: 'pass', attempts: 2 }] },
    ])
    assert.doesNotMatch(text, /FAIL/)
  })

  test('awaits a sink whose write returns a promise, so output stays in order', async () => {
    const chunks: string[] = []
    const slowSink = {
      async write(chunk: string): Promise<void> {
        await Promise.resolve()
        await Promise.resolve()
        chunks.push(chunk)
      },
    }
    const bus = createReporterBus([defaultReporter({ stream: slowSink, report: JESTLIKE })])
    await playRun(bus, [
      { path: 'a.test.ts', tests: [{ path: ['t'] }] },
      { path: 'b.test.ts', tests: [{ path: ['t'] }] },
    ])
    assert.match(chunks[0] ?? '', /^PASS a\.test\.ts/)
    assert.match(chunks[1] ?? '', /^PASS b\.test\.ts/)
    assert.match(chunks[2] ?? '', /Test Suites: 2 passed/)
    assert.equal(chunks.length, 3)
  })

  test('shows the time in seconds with three decimals', async () => {
    const out = output()
    const bus = createReporterBus([defaultReporter({ stream: out, report: JESTLIKE })])
    await bus.emit('run:end', { reason: 'passed', files: [], unhandled: [], durationMs: 61_234 })
    assert.match(out.text(), /Time: {8}61\.234 s/)
  })

  test('prints nothing for the events it has no use for', async () => {
    const out = output()
    const bus = createReporterBus([defaultReporter({ stream: out, report: JESTLIKE })])
    const file = fileInfo('x.test.ts')
    await bus.emit('file:queued', file)
    await bus.emit('file:start', file, 1)
    await bus.emit('console', file, {
      type: 'console',
      taskId: taskId('t'),
      stream: 'stdout',
      level: 'log',
      text: 'hello',
      origin: null,
      t: 1,
    })
    assert.equal(out.text(), '')
  })
})

describe('the default reporter: a suite’s own failure', () => {
  test('prints the afterAll error under the suite’s name path', async () => {
    const text = await report(
      [
        {
          path: 'suite.test.ts',
          tests: [{ path: ['outer', 'inner', 'works'] }],
          suiteErrors: [{ path: ['outer', 'inner'], errors: [error('AFTERALL EXPLODED')] }],
        },
      ],
      { policy: NEUTRAL },
    )
    assert.match(text, /^FAIL suite\.test\.ts$/m)
    assert.match(text, /outer > inner\n/)
    assert.match(text, /AFTERALL EXPLODED/)
    assert.doesNotMatch(text, /Test suite failed to run/)
  })
})

describe('the default reporter: an error charged to a test after it ended', () => {
  test('prints it under that test, and counts the test as failed', async () => {
    const file = buildFile({
      path: 'late.test.ts',
      state: 'fail',
      tests: [{ path: ['owner'] }, { path: ['bystander'] }],
    })
    const out = output()
    const bus = createReporterBus([defaultReporter({ stream: out, report: NEUTRAL })])
    await bus.emit('run:start', { root: '/project', projects: [''], startTime: 0, watch: false }, [
      file.info,
    ])
    await bus.emit('file:collected', file.info, collectedEvent(file))
    for (const { task, spec } of file.tests) {
      await bus.emit('task:end', task, testEndEvent(task, resultOf(spec)))
    }
    const [owner] = file.tests
    assert.ok(owner !== undefined)
    await bus.emit('unhandled', file.info, unhandledEvent(error('LATE BOOM'), owner.task.id))
    await bus.emit('file:end', file.result)
    await bus.emit('run:end', {
      reason: 'failed',
      files: [file.result],
      unhandled: [],
      durationMs: 1,
    })
    const text = out.text()
    assert.match(text, /^FAIL late\.test\.ts$/m)
    assert.match(text, /owner\n[\s\S]*LATE BOOM/)
    assert.match(text, /Tests:\s+1 failed, 1 passed, 2 total/)
  })

  test('adds to a test that already failed, and leaves another test`s count alone', async () => {
    const file = buildFile({
      path: 'late.test.ts',
      state: 'fail',
      tests: [
        { path: ['owner'], state: 'fail', errors: [error('FIRST BOOM')] },
        { path: ['bystander'] },
        { path: ['skipped'], state: 'skip' },
      ],
    })
    const out = output()
    const bus = createReporterBus([defaultReporter({ stream: out, report: NEUTRAL })])
    await bus.emit('run:start', { root: '/project', projects: [''], startTime: 0, watch: false }, [
      file.info,
    ])
    await bus.emit('file:collected', file.info, collectedEvent(file))
    for (const { task, spec } of file.tests) {
      await bus.emit('task:end', task, testEndEvent(task, resultOf(spec)))
    }
    const [owner, , skipped] = file.tests
    assert.ok(owner !== undefined && skipped !== undefined)
    await bus.emit('unhandled', file.info, unhandledEvent(error('LATE BOOM'), owner.task.id))
    await bus.emit('unhandled', file.info, unhandledEvent(error('LATER BOOM'), owner.task.id))
    await bus.emit('unhandled', file.info, unhandledEvent(error('SKIPPED BOOM'), skipped.task.id))
    await bus.emit('file:end', file.result)
    await bus.emit('run:end', {
      reason: 'failed',
      files: [file.result],
      unhandled: [],
      durationMs: 1,
    })
    const text = out.text()
    const titles = text.split('\n').filter((line) => line.trim().endsWith('owner'))
    assert.equal(titles.length, 1, 'the test is listed once')
    assert.match(text, /FIRST BOOM[\s\S]*LATE BOOM[\s\S]*LATER BOOM/)
    assert.match(text, /Tests:\s+1 failed, 1 skipped, 1 passed, 3 total/)
  })
})
