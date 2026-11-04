import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RuntimeEvent, TaskId, TaskResult } from '@provino/types'
import { checkOrder, type OrderInput } from './order.ts'

const F = 'ffffffffff' as TaskId
const G = 'gggggggggg' as TaskId
const id = (...path: number[]): TaskId => [F, ...path].join('_') as TaskId
const T0 = id(0)
const T1 = id(1)
const S = id(2)
const T_IN_S = id(2, 0)

const result = (state: TaskResult['state'] = 'pass'): TaskResult => ({
  state,
  durationMs: 0,
  startTime: 0,
  errors: [],
  retryErrors: [],
  attempts: 1,
  repeatIndex: 0,
  assertions: 0,
  passingAssertions: 0,
})

const run = (fileId: TaskId = F): OrderInput => ({ type: 'run', fileId })
const done: OrderInput = { type: 'fileDone' }
const collectStart = (fileId: TaskId = F): RuntimeEvent => ({
  type: 'file-collect-start',
  fileId,
  path: 'a.test.js',
  t: 0,
})
const collectEnd = (tests: readonly TaskId[] = [T0], fileId: TaskId = F): RuntimeEvent => ({
  type: 'file-collect-end',
  fileId,
  tasks: tests.map((taskId) => ({ type: 'test', id: taskId }) as never),
  errors: [],
  t: 0,
})
const fileEnd = (fileId: TaskId = F): RuntimeEvent => ({
  type: 'file-end',
  fileId,
  result: result(),
  t: 0,
})
const testStart = (taskId: TaskId): RuntimeEvent => ({ type: 'test-start', id: taskId, t: 0 })
const attemptStart = (taskId: TaskId, attempt = 0, repeat = 0): RuntimeEvent => ({
  type: 'test-attempt-start',
  id: taskId,
  attempt,
  repeat,
  t: 0,
})
const attemptEnd = (taskId: TaskId, attempt = 0, repeat = 0): RuntimeEvent => ({
  type: 'test-attempt-end',
  id: taskId,
  attempt,
  repeat,
  state: 'pass',
  errors: [],
  willRetry: false,
  t: 0,
})
const testEnd = (taskId: TaskId, state: TaskResult['state'] = 'pass'): RuntimeEvent => ({
  type: 'test-end',
  id: taskId,
  result: result(state),
  t: 0,
})
const hookStart = (testId: TaskId | null, ownerId: TaskId = F, ordinal = 0): RuntimeEvent => ({
  type: 'hook-start',
  ownerId,
  testId,
  kind: testId === null ? 'beforeAll' : 'beforeEach',
  ordinal,
  location: null,
  t: 0,
})
const hookEnd = (testId: TaskId | null, ownerId: TaskId = F, ordinal = 0): RuntimeEvent => ({
  type: 'hook-end',
  ownerId,
  testId,
  kind: testId === null ? 'beforeAll' : 'beforeEach',
  ordinal,
  error: null,
  t: 0,
})
const suiteStart = (taskId: TaskId): RuntimeEvent => ({ type: 'suite-start', id: taskId, t: 0 })
const suiteEnd = (taskId: TaskId): RuntimeEvent => ({
  type: 'suite-end',
  id: taskId,
  result: result(),
  t: 0,
})
const annotation = (testId: TaskId): RuntimeEvent => ({
  type: 'annotation',
  testId,
  message: 'm',
  kind: 'note',
  location: null,
  t: 0,
})
const consoleLog = (taskId: TaskId | null = null): RuntimeEvent => ({
  type: 'console',
  taskId,
  stream: 'stdout',
  level: 'log',
  text: 'x\n',
  origin: null,
  t: 0,
})
const unhandled: RuntimeEvent = {
  type: 'unhandled-error',
  ownerId: F,
  lastTestId: null,
  origin: 'uncaughtException',
  error: { name: 'Error', message: 'x' },
  t: 0,
}

/** A whole file around `middle`. */
const file = (middle: readonly OrderInput[], tests: readonly TaskId[] = [T0]): OrderInput[] => [
  run(),
  collectStart(),
  collectEnd(tests),
  ...middle,
  fileEnd(),
  done,
]
const oneTest: OrderInput[] = [
  testStart(T0),
  attemptStart(T0),
  hookStart(T0),
  hookEnd(T0),
  attemptEnd(T0),
  testEnd(T0),
]

/** A violation about the file `F`. */
const inF = (message: string): string => `${F}: ${message}`

const violations = (inputs: readonly OrderInput[]): string[] => [...checkOrder(inputs)]

describe('checkOrder: sequences that are in order', () => {
  it('accepts a file with a test, its hook, and the run ending', () => {
    assert.deepEqual(checkOrder(file(oneTest)), [])
  })

  it('accepts retries and repeats: several attempts between test-start and test-end', () => {
    assert.deepEqual(
      checkOrder(
        file([
          testStart(T0),
          attemptStart(T0, 0, 0),
          attemptEnd(T0, 0, 0),
          attemptStart(T0, 1, 0),
          attemptEnd(T0, 1, 0),
          attemptStart(T0, 0, 1),
          attemptEnd(T0, 0, 1),
          testEnd(T0),
        ]),
      ),
      [],
    )
  })

  it('accepts tests that run at the same time, each in order', () => {
    assert.deepEqual(
      checkOrder(
        file(
          [
            testStart(T0),
            testStart(T1),
            attemptStart(T0),
            attemptStart(T1),
            hookStart(T1),
            hookStart(T0),
            hookEnd(T0),
            hookEnd(T1),
            attemptEnd(T1),
            attemptEnd(T0),
            testEnd(T1),
            testEnd(T0),
          ],
          [T0, T1],
        ),
      ),
      [],
    )
  })

  it('accepts a skipped or todo test with no attempt, suites around tests, and suite hooks', () => {
    assert.deepEqual(
      checkOrder(
        file(
          [
            hookStart(null),
            hookEnd(null),
            suiteStart(S),
            testStart(T_IN_S),
            testEnd(T_IN_S, 'skip'),
            suiteEnd(S),
            testStart(T0),
            testEnd(T0, 'todo'),
          ],
          [T0, T_IN_S],
        ),
      ),
      [],
    )
  })

  it('accepts console output and unhandled errors anywhere, even after test-end and file-end', () => {
    assert.deepEqual(
      checkOrder([
        consoleLog(), // the worker’s own start-up output, before any file
        run(),
        collectStart(),
        consoleLog(T0),
        collectEnd(),
        ...oneTest,
        consoleLog(T0), // a floating promise writing after its test ended
        fileEnd(),
        consoleLog(),
        unhandled, // a teardown failure, charged after file-end
        done,
        run(G),
        collectStart(G),
        collectEnd([], G),
        fileEnd(G),
        done,
      ]),
      [],
    )
  })

  it('accepts several files, one after the other', () => {
    assert.deepEqual(checkOrder([...file(oneTest), ...file(oneTest)]), [])
  })
})

describe('checkOrder: each kind of violation', () => {
  it('file-collect-end before file-collect-start', () => {
    assert.deepEqual(violations([run(), collectEnd(), fileEnd(), done]).slice(0, 1), [
      inF('file-collect-end before file-collect-start'),
    ])
  })

  it('file-collect-start twice', () => {
    assert.ok(
      violations([run(), collectStart(), collectStart()]).includes(
        inF('file-collect-start twice, or after collecting'),
      ),
    )
  })

  it('file-end before file-collect-end', () => {
    assert.deepEqual(violations([run(), collectStart(), fileEnd(), done]).slice(0, 1), [
      inF('file-end before file-collect-end (collecting)'),
    ])
  })

  it('a test event before file-collect-end', () => {
    assert.deepEqual(violations([run(), collectStart(), testStart(T0)]).slice(0, 1), [
      `${T0}: test-start before file-collect-end (collecting)`,
    ])
  })

  it('fileDone before file-end, and fileDone with nothing running', () => {
    assert.deepEqual(violations([run(), collectStart(), collectEnd(), done]), [
      inF('fileDone before file-end (running)'),
    ])
    assert.deepEqual(violations([done]), ['fileDone with no file running'])
  })

  it('test-attempt-start before test-start', () => {
    assert.deepEqual(violations(file([attemptStart(T0)], [])).slice(0, 1), [
      `${T0}: test-attempt-start before test-start`,
    ])
  })

  it('test-start twice', () => {
    assert.deepEqual(
      violations(
        file([testStart(T0), testStart(T0), attemptStart(T0), attemptEnd(T0), testEnd(T0)]),
      ),
      [`${T0}: test-start twice`],
    )
  })

  it('test-attempt-start inside an open attempt', () => {
    assert.ok(
      violations(
        file([
          testStart(T0),
          attemptStart(T0),
          attemptStart(T0, 1),
          attemptEnd(T0, 1),
          testEnd(T0),
        ]),
      ).includes(`${T0}: test-attempt-start inside an open attempt`),
    )
  })

  it('test-attempt-end with no open attempt, and with the wrong numbers', () => {
    assert.ok(
      violations(file([testStart(T0), attemptEnd(T0), testEnd(T0, 'skip')])).includes(
        `${T0}: test-attempt-end with no open attempt`,
      ),
    )
    assert.ok(
      violations(
        file([testStart(T0), attemptStart(T0, 0), attemptEnd(T0, 1), testEnd(T0)]),
      ).includes(`${T0}: test-attempt-end is attempt 1/0, the open one is 0/0`),
    )
  })

  it('test-end inside an open attempt', () => {
    assert.deepEqual(violations(file([testStart(T0), attemptStart(T0), testEnd(T0)])), [
      `${T0}: test-end inside an open attempt`,
    ])
  })

  it('test-end with no attempt for a test that was not skipped', () => {
    assert.deepEqual(violations(file([testStart(T0), testEnd(T0, 'fail')])), [
      `${T0}: test-end (fail) without an attempt`,
    ])
  })

  it('anything for a test after its test-end', () => {
    const after = (event: RuntimeEvent) => violations(file([...oneTest, event]))
    assert.deepEqual(after(attemptStart(T0, 1)), [`${T0}: test-attempt-start after test-end`])
    assert.deepEqual(after(attemptEnd(T0)), [`${T0}: test-attempt-end after test-end`])
    assert.deepEqual(after(hookStart(T0)), [`${T0}: hook-start after test-end`])
    assert.deepEqual(after(annotation(T0)), [`${T0}: annotation after test-end`])
    assert.deepEqual(after(testEnd(T0)), [`${T0}: test-end after test-end`])
    assert.deepEqual(after(testStart(T0)), [`${T0}: test-start twice`])
  })

  it('a hook for a test outside its attempts, a hook-end with no hook-start, a hook-start twice', () => {
    assert.ok(
      violations(
        file([
          testStart(T0),
          hookStart(T0),
          hookEnd(T0),
          attemptStart(T0),
          attemptEnd(T0),
          testEnd(T0),
        ]),
      ).includes(`${T0}: hook-start (beforeEach) outside an attempt`),
    )
    assert.ok(
      violations(
        file([testStart(T0), attemptStart(T0), hookEnd(T0), attemptEnd(T0), testEnd(T0)]),
      ).some((message) => message.includes('hook-end without hook-start')),
    )
    assert.ok(
      violations(file([hookStart(null), hookStart(null), hookEnd(null)])).some((message) =>
        message.includes('hook-start twice'),
      ),
    )
  })

  it('anything structural after file-end', () => {
    const after = (event: RuntimeEvent) =>
      violations([run(), collectStart(), collectEnd([]), fileEnd(), event, done])
    assert.deepEqual(after(testStart(T0)), [`${T0}: test-start after file-end`])
    assert.deepEqual(after(suiteStart(S)), [`${S}: suite-start after file-end`])
    assert.deepEqual(after(fileEnd()), [inF('file-end twice')])
  })

  it('a test or suite or hook still open at file-end', () => {
    assert.deepEqual(violations(file([testStart(T0), attemptStart(T0)])), [
      `${T0}: test never ended before file-end`,
    ])
    assert.deepEqual(violations(file([suiteStart(S)], [])), [
      `${S}: suite never ended before file-end`,
    ])
    assert.ok(violations(file([hookStart(null)], [])).some((m) => m.includes('hook never ended')))
  })

  it('a collected test that never started', () => {
    assert.deepEqual(violations(file([], [T0])), [`${T0}: collected, but it never started`])
  })

  it('a suite that ends while a test in it is running, and a suite-end without suite-start', () => {
    assert.ok(
      violations(
        file(
          [
            suiteStart(S),
            testStart(T_IN_S),
            attemptStart(T_IN_S),
            suiteEnd(S),
            attemptEnd(T_IN_S),
            testEnd(T_IN_S),
          ],
          [T_IN_S],
        ),
      ).includes(`${S}: suite ended while its test ${T_IN_S} was still running`),
    )
    assert.deepEqual(violations(file([suiteEnd(S)], [])), [`${S}: suite-end without suite-start`])
  })

  it('an event that belongs to another file', () => {
    const other = `${G}_0` as TaskId
    assert.deepEqual(violations(file([testStart(other)], [])).slice(0, 1), [
      `${other}: test-start belongs to ${G}, not to the running file`,
    ])
    assert.deepEqual(violations([run(), collectStart(G)]).slice(0, 1), [
      inF(`file-collect-start names ${G}, not the running file`),
    ])
    assert.ok(
      violations([run(), collectStart(), collectEnd([], G)]).includes(
        inF(`file-collect-end names ${G}, not the running file`),
      ),
    )
    assert.ok(
      violations([run(), collectStart(), collectEnd([]), fileEnd(G)]).includes(
        inF(`file-end names ${G}, not the running file`),
      ),
    )
  })

  it('a wrong file id is reported once, by the checker alone', () => {
    // `runWorkerFiles` adds nothing of its own to `violations`: each wrong id is one entry here.
    const mentioning = (inputs: readonly OrderInput[]): string[] =>
      violations(inputs).filter((message) => message.includes(G))
    assert.deepEqual(mentioning([run(), collectStart(G), collectEnd(), fileEnd(), done]), [
      inF(`file-collect-start names ${G}, not the running file`),
    ])
    assert.deepEqual(mentioning([run(), collectStart(), collectEnd([], G), fileEnd(), done]), [
      inF(`file-collect-end names ${G}, not the running file`),
    ])
    assert.deepEqual(mentioning([run(), collectStart(), collectEnd([]), fileEnd(G), done]), [
      inF(`file-end names ${G}, not the running file`),
    ])
  })

  it('an id that only begins with the running file’s id belongs to another file', () => {
    const longer = `${F}a_0` as TaskId
    assert.deepEqual(violations(file([testStart(longer)], [])).slice(0, 1), [
      `${longer}: test-start belongs to ${F}a, not to the running file`,
    ])
  })

  it('an event with no file running', () => {
    assert.deepEqual(violations([testStart(T0)]), [`${T0}: test-start with no file running`])
    assert.deepEqual(violations([collectStart()]), ['file-collect-start with no file running'])
  })

  it('output after the last fileDone, and a job sent before the previous fileDone', () => {
    assert.deepEqual(violations([...file(oneTest), consoleLog()]), [
      'console output after the last fileDone',
    ])
    assert.deepEqual(violations([...file(oneTest), unhandled]), [
      'unhandled-error after the last fileDone',
    ])
    assert.ok(
      violations([run(), collectStart(), run(G)]).includes(
        inF('a job was sent before the previous file’s fileDone'),
      ),
    )
  })

  it('console output after a stop is the worker’s teardown, not a file’s late output', () => {
    const stop: OrderInput = { type: 'stop' }
    assert.deepEqual(violations([...file(oneTest), stop, consoleLog()]), [])
    // An unhandled error at stop still fails the run.
    assert.deepEqual(violations([...file(oneTest), stop, unhandled]), [
      'unhandled-error after the last fileDone',
    ])
    // Before the stop it is still late.
    assert.deepEqual(violations([...file(oneTest), consoleLog(), stop]), [
      'console output after the last fileDone',
    ])
  })

  it('a run that ends before fileDone', () => {
    assert.deepEqual(violations([run(), collectStart(), collectEnd([]), fileEnd()]), [
      inF('the run ended before fileDone'),
    ])
  })
})
