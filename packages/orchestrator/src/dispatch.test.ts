// The dispatcher over synthetic events: each runtime event reaches the bus with the node it
// refers to, in order and awaited; unknown ids and wrong kinds are `ORCH_BAD_EVENT`.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type {
  FileInfo,
  FileTask,
  ReporterBus,
  ReporterEvents,
  SerializedError,
  SuiteTask,
  TaskId,
  TaskResult,
  TestTask,
  WorkerEvent,
} from '@provino/types'
import { createFileDispatch, createIdleDispatch } from './dispatch.ts'

const id = (name: string): TaskId => name as TaskId
const base = { fileId: id('f'), mode: 'run', location: null, tags: [], meta: {} } as const

const fileNode: FileTask = {
  ...base,
  id: id('f'),
  parentId: null,
  type: 'file',
  name: 'a.test.ts',
  path: 'a.test.ts',
  projectName: 'p',
  children: [id('s')],
}
const suiteNode: SuiteTask = {
  ...base,
  id: id('s'),
  parentId: id('f'),
  type: 'suite',
  name: 'suite',
  children: [id('t')],
  each: false,
  concurrent: false,
  shuffle: false,
}
const testNode: TestTask = {
  ...base,
  id: id('t'),
  parentId: id('s'),
  type: 'test',
  name: 'works',
  fullName: ['suite', 'works'],
  dupIndex: 0,
  each: false,
  concurrent: false,
  expectFail: false,
  timeoutMs: 5000,
  retry: 0,
  repeats: 0,
}
const info: FileInfo = { fileId: id('f'), path: 'a.test.ts', project: 'p' }

const result: TaskResult = {
  state: 'pass',
  durationMs: 1,
  startTime: 0,
  errors: [],
  retryErrors: [],
  attempts: 1,
  repeatIndex: 0,
  assertions: 0,
  passingAssertions: 0,
}

const collected: WorkerEvent = {
  type: 'file-collect-end',
  fileId: id('f'),
  tasks: [fileNode, suiteNode, testNode],
  errors: [],
  t: 1,
}

type Recorded = readonly [event: string, ...args: unknown[]]

function recordingBus(wait?: Promise<void>): { bus: ReporterBus; seen: Recorded[] } {
  const seen: Recorded[] = []
  const bus: ReporterBus = {
    async emit<K extends keyof ReporterEvents>(event: K, ...args: ReporterEvents[K]) {
      await wait
      seen.push([event, ...args])
    },
    add: () => {},
  }
  return { bus, seen }
}

const boom: SerializedError = { name: 'Error', message: 'boom' }

describe('createFileDispatch', () => {
  it('pairs each event with its node, in order', async () => {
    const { bus, seen } = recordingBus()
    const dispatch = createFileDispatch({ bus, file: info, onUnhandled: () => {} })
    const events: WorkerEvent[] = [
      { type: 'file-collect-start', fileId: id('f'), path: 'a.test.ts', t: 0 },
      collected,
      { type: 'suite-start', id: id('s'), t: 2 },
      { type: 'test-start', id: id('t'), t: 3 },
      { type: 'test-attempt-start', id: id('t'), attempt: 1, repeat: 0, t: 4 },
      {
        type: 'hook-start',
        ownerId: id('s'),
        testId: id('t'),
        kind: 'beforeEach',
        ordinal: 0,
        location: null,
        t: 5,
      },
      {
        type: 'hook-end',
        ownerId: id('s'),
        testId: id('t'),
        kind: 'beforeEach',
        ordinal: 0,
        error: null,
        t: 6,
      },
      { type: 'annotation', testId: id('t'), message: 'hi', kind: 'note', location: null, t: 7 },
      {
        type: 'console',
        taskId: id('t'),
        stream: 'stdout',
        level: 'log',
        text: 'x',
        origin: null,
        t: 8,
      },
      {
        type: 'test-attempt-end',
        id: id('t'),
        attempt: 1,
        repeat: 0,
        state: 'pass',
        errors: [],
        willRetry: false,
        t: 9,
      },
      { type: 'test-end', id: id('t'), result, t: 10 },
      { type: 'suite-end', id: id('s'), result, t: 11 },
      { type: 'file-end', fileId: id('f'), result, t: 12 },
    ]
    await dispatch.handle(events)

    assert.deepEqual(
      seen.map((entry) => entry[0]),
      [
        'file:collected',
        'task:start',
        'task:start',
        'test:attempt-start',
        'hook:start',
        'hook:end',
        'annotation',
        'console',
        'test:attempt-end',
        'task:end',
        'task:end',
      ],
    )
    assert.equal(seen[0]?.[1], info)
    assert.equal(seen[1]?.[1], suiteNode)
    assert.equal(seen[2]?.[1], testNode)
    assert.equal(seen[4]?.[1], suiteNode, 'a hook is paired with the suite that owns it')
    assert.equal(seen[6]?.[1], testNode)
    assert.equal(seen[7]?.[1], info)
    assert.equal(seen[9]?.[1], testNode)
    assert.equal(seen[10]?.[1], suiteNode)
    assert.equal(seen[2]?.[2], events[3], 'the event itself comes along')
  })

  it('keeps the file-end result, the collected test count and drops events no reporter has', async () => {
    const { bus, seen } = recordingBus()
    const dispatch = createFileDispatch({ bus, file: info, onUnhandled: () => {} })
    assert.equal(dispatch.result, undefined)
    assert.equal(dispatch.tests, 0)
    await dispatch.handle([
      { type: 'coverage', fileId: id('f'), payload: { type: 'json', json: '{}' }, t: 0 },
      { type: 'deps', fileId: id('f'), modules: ['/x'], t: 0 },
      collected,
      { type: 'file-end', fileId: id('f'), result, t: 1 },
    ])
    assert.equal(dispatch.result, result)
    assert.equal(dispatch.tests, 1)
    assert.deepEqual(
      seen.map((entry) => entry[0]),
      ['file:collected'],
    )
  })

  it('awaits the bus before it settles: a slow reporter holds the pack', async () => {
    const gate = Promise.withResolvers<void>()
    const { bus, seen } = recordingBus(gate.promise)
    const dispatch = createFileDispatch({ bus, file: info, onUnhandled: () => {} })
    let settled = false
    const handled = dispatch.handle([collected]).then(() => {
      settled = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(settled, false)
    assert.deepEqual(seen, [])
    gate.resolve()
    await handled
    assert.equal(seen.length, 1)
  })

  it('reports an unhandled error to the run, and ties it to the file only if a task owns it', async () => {
    const { bus, seen } = recordingBus()
    const reported: SerializedError[] = []
    const dispatch = createFileDispatch({
      bus,
      file: info,
      onUnhandled: (e) => void reported.push(e),
    })
    await dispatch.handle([
      collected,
      {
        type: 'unhandled-error',
        ownerId: id('t'),
        lastTestId: null,
        origin: 'uncaughtException',
        error: boom,
        t: 1,
      },
      {
        type: 'unhandled-error',
        ownerId: null,
        lastTestId: null,
        origin: 'unhandledRejection',
        error: boom,
        t: 2,
      },
    ])
    assert.deepEqual(reported, [boom, boom])
    assert.deepEqual(dispatch.unhandled, [boom, boom])
    assert.equal(seen[1]?.[1], info)
    assert.equal(seen[2]?.[1], null)
  })

  it('rejects an event for a task it was never told about', async () => {
    const { bus } = recordingBus()
    const dispatch = createFileDispatch({ bus, file: info, onUnhandled: () => {} })
    await assert.rejects(dispatch.handle([{ type: 'test-start', id: id('t'), t: 0 }]), {
      code: 'ORCH_BAD_EVENT',
      message: /test-start.*never announced/,
    })
  })

  it('rejects an event that names the wrong kind of task', async () => {
    const { bus } = recordingBus()
    const dispatch = createFileDispatch({ bus, file: info, onUnhandled: () => {} })
    await dispatch.handle([collected])
    const wrong: WorkerEvent[] = [
      { type: 'test-attempt-start', id: id('s'), attempt: 1, repeat: 0, t: 0 },
      { type: 'annotation', testId: id('s'), message: '', kind: '', location: null, t: 0 },
      {
        type: 'hook-start',
        ownerId: id('t'),
        testId: null,
        kind: 'beforeAll',
        ordinal: 0,
        location: null,
        t: 0,
      },
      { type: 'suite-start', id: id('f'), t: 0 },
    ]
    for (const event of wrong) {
      await assert.rejects(dispatch.handle([event]), { code: 'ORCH_BAD_EVENT' }, event.type)
    }
  })
})

describe('createIdleDispatch', () => {
  const unhandled = (): WorkerEvent => ({
    type: 'unhandled-error',
    ownerId: null,
    lastTestId: null,
    origin: 'uncaughtException',
    error: boom,
    t: 0,
  })
  const line: WorkerEvent = {
    type: 'console',
    taskId: null,
    stream: 'stderr',
    level: 'warn',
    text: 'left behind',
    origin: null,
    t: 0,
  }

  it('shows a console line under the file the worker ran last', async () => {
    const { bus, seen } = recordingBus()
    const dispatch = createIdleDispatch({
      bus,
      fileOf: (workerId) => (workerId === 1 ? info : undefined),
      onUnhandled: () => {},
    })
    await dispatch(1, [line])
    await dispatch(2, [line])
    assert.deepEqual(seen, [['console', info, line]])
  })

  it('reports an unhandled error to the run, tied to no file', async () => {
    const { bus, seen } = recordingBus()
    const reported: SerializedError[] = []
    const dispatch = createIdleDispatch({
      bus,
      fileOf: () => info,
      onUnhandled: (e) => void reported.push(e),
    })
    await dispatch(1, [unhandled()])
    assert.deepEqual(reported, [boom])
    assert.equal(seen[0]?.[1], null)
  })

  it('rejects an event that belongs to a file', async () => {
    const { bus } = recordingBus()
    const dispatch = createIdleDispatch({ bus, fileOf: () => info, onUnhandled: () => {} })
    await assert.rejects(dispatch(1, [{ type: 'test-start', id: id('t'), t: 0 }]), {
      code: 'ORCH_BAD_EVENT',
    })
  })
})
