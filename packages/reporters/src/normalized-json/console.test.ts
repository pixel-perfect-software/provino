// The normalized-json reporter's console output (T12.16, B15 gap 8): per test by `taskId`, per
// file otherwise, one entry per line.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NormalizedRun, RuntimeEventOf, TaskId } from '@provino/types'
import { createReporterBus } from '../bus.ts'
import {
  buildFile,
  collectedEvent,
  FIXED_ENV,
  output,
  resultOf,
  testEndEvent,
  testStartEvent,
} from '../internal/test-support.ts'
import { linesOf } from './build.ts'
import { normalizedJsonReporter } from './reporter.ts'

// The same table pins `consoleLines` in @provino/harness (`src/sidecar.test.ts`), which splits
// Jest's and Vitest's console the same way; this package can't import it. Change both together.
const LINE_CASES: readonly [string, readonly string[]][] = [
  ['a', ['a']],
  ['a\n', ['a']],
  ['a\nb\n', ['a', 'b']],
  ['a\n\n', ['a', '']],
  ['a\r\nb', ['a\r', 'b']],
  ['', ['']],
  ['\n', ['']],
]

test('a write splits into lines as the harness splits a sidecar entry', () => {
  for (const [text, lines] of LINE_CASES) {
    assert.deepEqual(linesOf(text), lines, JSON.stringify(text))
  }
})

function write(
  taskId: TaskId | null,
  text: string,
  extra: Partial<RuntimeEventOf<'console'>> = {},
): RuntimeEventOf<'console'> {
  return {
    type: 'console',
    taskId,
    stream: 'stdout',
    level: 'log',
    text,
    origin: null,
    t: 2,
    ...extra,
  }
}

async function runWithConsole(
  writes: (ids: {
    file: TaskId
    suite: TaskId
    first: TaskId
    second: TaskId
  }) => readonly RuntimeEventOf<'console'>[],
): Promise<NormalizedRun> {
  const out = output()
  const bus = createReporterBus([
    normalizedJsonReporter({
      stream: out,
      suite: 's',
      runner: 'provino:test',
      runnerVersion: '0.0.0',
      env: FIXED_ENV,
      now: () => 0,
    }),
  ])
  const file = buildFile({
    path: 'a.test.ts',
    tests: [{ path: ['group', 'first'] }, { path: ['group', 'second'] }],
  })
  const [first, second] = file.tests
  const suite = file.tasks.find((task) => task.type === 'suite')
  assert.ok(first && second && suite)
  await bus.emit('run:start', { root: '/p', projects: [''], startTime: 0, watch: false }, [
    file.info,
  ])
  await bus.emit('file:start', file.info, 0)
  await bus.emit('file:collected', file.info, collectedEvent(file))
  const events = writes({
    file: file.info.fileId,
    suite: suite.id,
    first: first.task.id,
    second: second.task.id,
  })
  // Every write is sent while the first test runs: the reporter goes by `taskId`, not by timing.
  for (const [index, { task, spec }] of file.tests.entries()) {
    await bus.emit('task:start', task, testStartEvent(task))
    if (index === 0) for (const event of events) await bus.emit('console', file.info, event)
    await bus.emit('task:end', task, testEndEvent(task, resultOf(spec)))
  }
  await bus.emit('file:end', file.result)
  await bus.emit('run:end', {
    reason: 'passed',
    files: [file.result],
    unhandled: [],
    durationMs: 1,
  })
  assert.deepEqual(bus.failures(), [])
  return JSON.parse(out.text()) as NormalizedRun
}

test('a write in a test goes to that test; a suite, the file or no task go to the file', async () => {
  const run = await runWithConsole((ids) => [
    write(ids.first, 'in first\n'),
    write(ids.second, 'in second', { stream: 'stderr', level: 'warn' }),
    write(ids.suite, 'in the suite beforeAll\n'),
    write(ids.file, 'at the top level\n'),
    write(null, 'outside any task\n', { level: null }),
    write(ids.first, 'two\nlines\n'),
  ])
  const [file] = run.files
  assert.ok(file)
  assert.deepEqual(file.tests[0]?.console, [
    { stream: 'stdout', text: 'in first', level: 'log' },
    { stream: 'stdout', text: 'two', level: 'log' },
    { stream: 'stdout', text: 'lines', level: 'log' },
  ])
  assert.deepEqual(file.tests[1]?.console, [{ stream: 'stderr', text: 'in second', level: 'warn' }])
  assert.deepEqual(file.console, [
    { stream: 'stdout', text: 'in the suite beforeAll', level: 'log' },
    { stream: 'stdout', text: 'at the top level', level: 'log' },
    { stream: 'stdout', text: 'outside any task' },
  ])
})

test('a file and tests that wrote nothing have no console, and an empty line stays one line', async () => {
  const run = await runWithConsole((ids) => [write(ids.first, '\n'), write(ids.first, '')])
  const [file] = run.files
  assert.ok(file)
  assert.equal('console' in file, false)
  assert.equal(file.tests[1] !== undefined && 'console' in file.tests[1], false)
  assert.deepEqual(file.tests[0]?.console, [
    { stream: 'stdout', text: '', level: 'log' },
    { stream: 'stdout', text: '', level: 'log' },
  ])
})
