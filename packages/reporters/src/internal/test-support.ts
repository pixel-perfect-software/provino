// Test helpers for the reporters' unit tests (not a test file): synthetic runs built to the real
// types. A `FileSpec` describes one file and the events it would produce; `playRun` sends a
// whole run through a bus, as the coordinator will.

import assert from 'node:assert/strict'
import type {
  FileInfo,
  FileResult,
  FileTask,
  OpenHandle,
  Reporter,
  ReporterBus,
  ReportPolicy,
  RunEnvironment,
  RunSummary,
  RuntimeEventOf,
  SerializedError,
  SkipReason,
  SnapshotRunSummary,
  SuiteTask,
  TaskId,
  TaskNode,
  TaskResult,
  TaskState,
  TestTask,
  WorkerExit,
} from '@provino/types'
import { createReporterBus } from '../bus.ts'

/** The `report` slice as the Jest dialect has it (`jestPolicy.report`), for tests that need no more than its values. */
export const JEST_REPORT: ReportPolicy = {
  displaySeparator: ' › ',
  defaultReporters: ['default'],
  failureTitleBullet: '  ● ',
  listTestsForSingleFile: true,
  resultStatusSkipped: 'pending',
}

/** The neutral `report` slice (`neutralPolicy.report`). */
export const NEUTRAL_REPORT: ReportPolicy = {
  displaySeparator: ' > ',
  defaultReporters: ['default'],
  failureTitleBullet: null,
  listTestsForSingleFile: false,
  resultStatusSkipped: 'skipped',
}

/** The ids are plain text in tests; the brand is what the real coordinator's hash carries. */
export function taskId(text: string): TaskId {
  return text as TaskId
}

export function fileInfo(path: string, project = ''): FileInfo {
  return { fileId: taskId(`file:${project}:${path}`), path, project }
}

export function error(message: string, extra: Partial<SerializedError> = {}): SerializedError {
  return { name: 'Error', message, ...extra }
}

export function taskResult(state: TaskState, extra: Partial<TaskResult> = {}): TaskResult {
  return {
    state,
    durationMs: 1,
    startTime: 0,
    errors: [],
    retryErrors: [],
    attempts: 1,
    repeatIndex: 0,
    assertions: 0,
    passingAssertions: 0,
    ...extra,
  }
}

/** One console write in a `FileSpec` or `TestSpec`. */
export interface ConsoleSpec {
  /** Default `stdout`. */
  readonly stream?: 'stdout' | 'stderr'
  /** The console method, or `null` for a write to the stream itself. Default `log`. */
  readonly level?: string | null
  readonly text: string
  /** Where the call was made. Default `null`: the worker doesn't capture one yet. */
  readonly origin?: string | null
}

/** One test in a `FileSpec`. */
export interface TestSpec {
  /** Describe titles, then the test title. */
  readonly path: readonly string[]
  /** How it ended. Default `pass`. */
  readonly state?: 'pass' | 'fail' | 'skip' | 'todo'
  /** `false`: collected but never ended (the worker died, the run stopped). Default `true`. */
  readonly ran?: boolean
  readonly errors?: readonly SerializedError[]
  readonly durationMs?: number
  readonly skipReason?: SkipReason
  readonly passingAssertions?: number
  /** Attempts in the result. Default: `retries` + `repeats` + 1; with only this, it is all retries. */
  readonly attempts?: number
  /** Real retries: failed attempts of the first repeat that ran again (`test:attempt-end` with `willRetry`). */
  readonly retries?: number
  /** Repeats after the first run: each is one more attempt, not a retry. */
  readonly repeats?: number
  readonly expectFail?: boolean
  readonly location?: { readonly line: number; readonly column: number }
  /** Console writes while the test ran, sent before its `test-end`. */
  readonly console?: readonly ConsoleSpec[]
}

/** One file in a run. */
export interface FileSpec {
  readonly path: string
  readonly project?: string
  readonly tests?: readonly TestSpec[]
  /** The file's own outcome. Default `fail` if any test failed, else `pass`. */
  readonly state?: 'pass' | 'fail' | 'skip'
  /** The file's own errors: a collection error, a failing `afterAll`. */
  readonly errors?: readonly SerializedError[]
  /** Suites that ended `fail` with errors of their own (an `afterAll` in a describe). */
  readonly suiteErrors?: readonly {
    readonly path: readonly string[]
    readonly errors: readonly SerializedError[]
  }[]
  readonly durationMs?: number
  readonly workerExit?: WorkerExit
  /** Console writes outside any test (a `beforeAll`, the top level), sent before the first test. */
  readonly console?: readonly ConsoleSpec[]
}

/** A file's tree and the events it produces, built from its spec. */
export interface BuiltFile {
  readonly info: FileInfo
  readonly tasks: readonly TaskNode[]
  /** Each test's task, with its spec, in declaration order. */
  readonly tests: readonly { readonly task: TestTask; readonly spec: TestSpec }[]
  /** The suite task for each `suiteErrors` entry, with its errors. */
  readonly suiteEnds: readonly {
    readonly task: SuiteTask
    readonly errors: readonly SerializedError[]
  }[]
  readonly result: FileResult
}

/**
 * Builds a file's task tree (a suite for each distinct describe prefix, parents before children,
 * depth first) and its `FileResult`. `dupIndex` counts tests with the same full name.
 */
export function buildFile(spec: FileSpec): BuiltFile {
  const info = fileInfo(spec.path, spec.project ?? '')
  const fileId = info.fileId
  const specs = spec.tests ?? []
  const base = { fileId, mode: 'run' as const, location: null, tags: [], meta: {} }
  const tasks: TaskNode[] = []
  const tests: { task: TestTask; spec: TestSpec }[] = []
  const children = new Map<TaskId, TaskId[]>()
  const suites = new Map<string, SuiteTask>()
  const dupCounts = new Map<string, number>()
  const root: FileTask = {
    ...base,
    id: fileId,
    parentId: null,
    name: spec.path,
    type: 'file',
    path: spec.path,
    projectName: spec.project ?? '',
    children: [],
  }
  tasks.push(root)
  children.set(fileId, [])

  function suiteFor(path: readonly string[]): TaskId {
    if (path.length === 0) return fileId
    const key = JSON.stringify(path)
    const existing = suites.get(key)
    if (existing !== undefined) return existing.id
    const parentId = suiteFor(path.slice(0, -1))
    const id = taskId(`${fileId}/s${suites.size}`)
    const suite: SuiteTask = {
      ...base,
      id,
      parentId,
      name: path[path.length - 1] ?? '',
      type: 'suite',
      children: [],
      each: false,
      concurrent: false,
      shuffle: false,
    }
    suites.set(key, suite)
    children.set(id, [])
    children.get(parentId)?.push(id)
    tasks.push(suite)
    return id
  }

  for (const testSpec of specs) {
    const parentId = suiteFor(testSpec.path.slice(0, -1))
    const key = JSON.stringify(testSpec.path)
    const dupIndex = dupCounts.get(key) ?? 0
    dupCounts.set(key, dupIndex + 1)
    const id = taskId(`${fileId}/t${tests.length}`)
    const task: TestTask = {
      ...base,
      id,
      parentId,
      name: testSpec.path[testSpec.path.length - 1] ?? '',
      location: testSpec.location === undefined ? null : { file: spec.path, ...testSpec.location },
      type: 'test',
      fullName: testSpec.path,
      dupIndex,
      each: false,
      concurrent: false,
      expectFail: testSpec.expectFail ?? false,
      timeoutMs: 5000,
      retry: 0,
      repeats: 0,
    }
    children.get(parentId)?.push(id)
    tasks.push(task)
    tests.push({ task, spec: testSpec })
  }

  // Tasks hold their children by id and are read-only, so rebuild each parent with its list.
  const withChildren = tasks.map((task): TaskNode => {
    if (task.type === 'test') return task
    return { ...task, children: children.get(task.id) ?? [] }
  })
  const suiteEnds = (spec.suiteErrors ?? []).map(({ path, errors }) => {
    const task = suites.get(JSON.stringify(path))
    if (task === undefined) throw new Error(`no tests under the suite ${JSON.stringify(path)}`)
    return { task, errors }
  })
  const anyFailed =
    specs.some((t) => t.state === 'fail') || suiteEnds.some((end) => end.errors.length > 0)
  const state = spec.state ?? (anyFailed ? 'fail' : 'pass')
  return {
    info,
    tasks: withChildren,
    tests,
    suiteEnds,
    result: {
      file: info,
      state,
      durationMs: spec.durationMs ?? 5,
      ...(spec.workerExit === undefined ? {} : { workerExit: spec.workerExit }),
      errors: spec.errors ?? [],
    },
  }
}

/** The same tree with its tasks ordered by depth: still parents before children, but not declaration order. */
export function breadthFirst(tasks: readonly TaskNode[]): TaskNode[] {
  const parents = new Map(tasks.map((task) => [task.id, task.parentId]))
  const depth = (id: TaskId | null): number =>
    id === null ? -1 : 1 + depth(parents.get(id) ?? null)
  return tasks.toSorted((a, b) => depth(a.id) - depth(b.id))
}

export function collectedEvent(
  file: BuiltFile,
  tasks: readonly TaskNode[] = file.tasks,
  errors: readonly SerializedError[] = [],
): RuntimeEventOf<'file-collect-end'> {
  return { type: 'file-collect-end', fileId: file.info.fileId, tasks, errors, t: 1 }
}

export function testEndEvent(task: TestTask, result: TaskResult): RuntimeEventOf<'test-end'> {
  return { type: 'test-end', id: task.id, result, t: 2 }
}

export function testStartEvent(task: TestTask): RuntimeEventOf<'test-start'> {
  return { type: 'test-start', id: task.id, t: 2 }
}

export function unhandledEvent(
  err: SerializedError,
  ownerId: TaskId | null = null,
): RuntimeEventOf<'unhandled-error'> {
  return {
    type: 'unhandled-error',
    ownerId,
    lastTestId: null,
    origin: 'uncaughtException',
    error: err,
    t: 3,
  }
}

/** The result a test's spec says it had. */
export function resultOf(spec: TestSpec): TaskResult {
  return taskResult(spec.state ?? 'pass', {
    errors: spec.errors ?? [],
    ...(spec.durationMs === undefined ? {} : { durationMs: spec.durationMs }),
    ...(spec.skipReason === undefined ? {} : { skipReason: spec.skipReason }),
    ...(spec.passingAssertions === undefined ? {} : { passingAssertions: spec.passingAssertions }),
    attempts: spec.attempts ?? (spec.retries ?? 0) + (spec.repeats ?? 0) + 1,
    repeatIndex: spec.repeats ?? 0,
  })
}

/** The attempt events a spec's retries and repeats would produce, ahead of its `test-end`. */
export function attemptEndEvents(
  task: TestTask,
  spec: TestSpec,
): RuntimeEventOf<'test-attempt-end'>[] {
  const retries = spec.retries ?? (spec.repeats === undefined ? (spec.attempts ?? 1) - 1 : 0)
  const events: RuntimeEventOf<'test-attempt-end'>[] = []
  for (let repeat = 0; repeat <= (spec.repeats ?? 0); repeat++) {
    const failedAttempts = repeat === 0 ? retries : 0
    for (let attempt = 0; attempt <= failedAttempts; attempt++) {
      const retrying = attempt < failedAttempts
      events.push({
        type: 'test-attempt-end',
        id: task.id,
        attempt,
        repeat,
        state: retrying ? 'fail' : 'pass',
        errors: [],
        willRetry: retrying,
        t: 2,
      })
    }
  }
  return events
}

export function consoleEvent(write: ConsoleSpec, taskId: TaskId | null): RuntimeEventOf<'console'> {
  return {
    type: 'console',
    taskId,
    stream: write.stream ?? 'stdout',
    level: write.level === undefined ? 'log' : write.level,
    text: write.text,
    origin: write.origin ?? null,
    t: 2,
  }
}

/** Sends one file's events, in the order the coordinator will: queued, start, collected, each test, end. */
export async function emitFile(bus: ReporterBus, spec: FileSpec): Promise<FileResult> {
  const file = buildFile(spec)
  await bus.emit('file:queued', file.info)
  await bus.emit('file:start', file.info, 0)
  await bus.emit('file:collected', file.info, collectedEvent(file))
  for (const write of spec.console ?? []) {
    await bus.emit('console', file.info, consoleEvent(write, null))
  }
  for (const { task, spec: testSpec } of file.tests) {
    if (testSpec.ran === false) continue
    await bus.emit('task:start', task, testStartEvent(task))
    for (const write of testSpec.console ?? []) {
      await bus.emit('console', file.info, consoleEvent(write, task.id))
    }
    for (const attempt of attemptEndEvents(task, testSpec)) {
      await bus.emit('test:attempt-end', task, attempt)
    }
    await bus.emit('task:end', task, testEndEvent(task, resultOf(testSpec)))
  }
  for (const { task, errors } of file.suiteEnds) {
    await bus.emit('task:end', task, {
      type: 'suite-end',
      id: task.id,
      result: taskResult('fail', { errors }),
      t: 2,
    })
  }
  await bus.emit('file:end', file.result)
  return file.result
}

/** What `playRun` adds to a run of files. */
export interface PlayOptions {
  readonly unhandled?: readonly SerializedError[]
  readonly durationMs?: number
  readonly snapshots?: SnapshotRunSummary
  /** The run's end reason; default `failed` when a file failed, else `passed`. */
  readonly reason?: RunSummary['reason']
  /** Files announced at `run:start` that never ran (a run that bailed). */
  readonly notRun?: readonly string[]
  /** What `detectOpenHandles` found, for the summary. */
  readonly openHandles?: readonly OpenHandle[]
}

/** A run: `run:start`, every file, then `run:end` with a summary built from them. */
export async function playRun(
  bus: ReporterBus,
  files: readonly FileSpec[],
  options: PlayOptions = {},
): Promise<RunSummary> {
  const infos = [
    ...files.map((spec) => fileInfo(spec.path, spec.project ?? '')),
    ...(options.notRun ?? []).map((path) => fileInfo(path, '')),
  ]
  await bus.emit(
    'run:start',
    { root: '/project', projects: [''], startTime: 0, watch: false },
    infos,
  )
  const results: FileResult[] = []
  for (const spec of files) results.push(await emitFile(bus, spec))
  const failed = results.some((r) => r.state === 'fail')
  const summary: RunSummary = {
    reason: options.reason ?? (failed ? 'failed' : 'passed'),
    files: results,
    unhandled: options.unhandled ?? [],
    durationMs: options.durationMs ?? 1234,
    ...(options.snapshots === undefined ? {} : { snapshots: options.snapshots }),
    ...(options.openHandles === undefined ? {} : { openHandles: options.openHandles }),
  }
  await bus.emit('run:end', summary)
  return summary
}

/** A buffer for a `TextSink`. */
export interface Output {
  write(chunk: string): void
  text(): string
  /** Each write, as it was made. */
  writes(): readonly string[]
}

export function output(): Output {
  const chunks: string[] = []
  return {
    write: (chunk) => {
      chunks.push(chunk)
    },
    text: () => chunks.join(''),
    writes: () => chunks,
  }
}

/** The machine a test run reports, fixed so the JSON can be compared whole. */
export const FIXED_ENV: RunEnvironment = {
  os: 'testos',
  osRelease: '1.0',
  arch: 'x64',
  cpuModel: 'Test CPU',
  cpuCount: 4,
  memoryMb: 8192,
  node: 'v24.0.0',
  runners: { provino: '0.0.0' },
  ci: false,
}

/**
 * A reporter that logs `name:event` for `run:start`, `file:queued`, `file:end`, `run:end`, and
 * `name:error message` for `error`, into `log`. It throws on the event `throwOn` names.
 */
export function recorder(
  name: string,
  log: string[],
  behaviour: { readonly throwOn?: string } = {},
): Reporter {
  const seen = (event: string, detail = ''): void => {
    log.push(`${name}:${event}${detail}`)
    if (behaviour.throwOn === event) throw new Error(`${name} threw on ${event}`)
  }
  return {
    name,
    'run:start': () => seen('run:start'),
    'file:queued': () => seen('file:queued'),
    'file:end': () => seen('file:end'),
    'run:end': () => seen('run:end'),
    error: (err) => seen('error', ` ${err.message}`),
  }
}

// The fixture run: the one run every built-in reporter's golden is taken from (T9.7): a passing file with nested
// `describe`s, a failing test, a skipped and a todo test, a file whose every test is skipped, a
// todo-only file, console output (a `log`, a `warn`, a direct write, and a write outside any
// test), a stored snapshot that differs, and a file that fails to collect. Test support, not a
// test file.

/** A failed `toBe`, as the expect layer's error reads. */
const toBeError: SerializedError = error(
  'expect(received).toBe(expected) // Object.is equality\n\nExpected: 2\nReceived: 1',
  {
    stack: [
      'Error: expect(received).toBe(expected) // Object.is equality',
      '',
      'Expected: 2',
      'Received: 1',
      '    at Object.<anonymous> (/project/fails.test.ts:3:15)',
      '    at run (/project/node_modules/lib/run.js:1:1)',
      '    at node:internal/process/task_queues:1:1',
    ].join('\n'),
    location: { file: '/project/fails.test.ts', line: 3, column: 15 },
  },
)

/** A stored snapshot that differs from the received value. */
const snapshotError: SerializedError = error(
  [
    'expect(received).toMatchSnapshot()',
    '',
    'Snapshot name: `matches a stored snapshot 1`',
    '',
    '- Snapshot  - 1',
    '+ Received  + 1',
    '',
    '  {',
    '-   "value": "old",',
    '+   "value": "new",',
    '  }',
  ].join('\n'),
  {
    stack: [
      'Error: expect(received).toMatchSnapshot()',
      '    at Object.<anonymous> (/project/snapshot.test.ts:2:28)',
    ].join('\n'),
  },
)

/** The fixture run's files, in the order they finish. */
export const FIXTURE_FILES: readonly FileSpec[] = [
  {
    path: 'math.test.ts',
    durationMs: 12,
    tests: [
      { path: ['math', 'adds'], durationMs: 3 },
      { path: ['math', 'nested', 'subtracts'], durationMs: 0.4 },
      { path: ['stands alone'], durationMs: 2 },
    ],
  },
  {
    path: 'fails.test.ts',
    durationMs: 9,
    tests: [
      {
        path: ['group', 'fails'],
        state: 'fail',
        durationMs: 4,
        errors: [toBeError],
        location: { line: 2, column: 3 },
      },
      { path: ['group', 'passes after'], durationMs: 1 },
    ],
  },
  {
    path: 'skipped.test.ts',
    durationMs: 3,
    tests: [
      { path: ['runs'], durationMs: 2 },
      { path: ['is skipped'], state: 'skip', skipReason: 'modifier' },
      { path: ['is planned'], state: 'todo' },
    ],
  },
  {
    path: 'all-skipped.test.ts',
    state: 'skip',
    durationMs: 1,
    tests: [
      { path: ['first'], state: 'skip', skipReason: 'modifier' },
      { path: ['second'], state: 'skip', skipReason: 'modifier' },
    ],
  },
  {
    path: 'todo-only.test.ts',
    // The orchestrator decides it: `orchestrator.todoOnlyFile` is `pass` under Jest (DV50).
    state: 'pass',
    durationMs: 1,
    tests: [{ path: ['later'], state: 'todo' }],
  },
  {
    path: 'console.test.ts',
    durationMs: 6,
    console: [{ text: 'at import time\n' }],
    tests: [
      {
        path: ['logs and warns'],
        durationMs: 2,
        console: [
          { text: 'from the test\n' },
          { level: 'warn', stream: 'stderr', text: 'a warning\n' },
          { level: null, text: 'a direct write\n' },
        ],
      },
    ],
  },
  {
    path: 'snapshot.test.ts',
    durationMs: 7,
    tests: [
      {
        path: ['matches a stored snapshot'],
        state: 'fail',
        durationMs: 5,
        errors: [snapshotError],
      },
    ],
  },
  {
    path: 'broken.test.ts',
    state: 'fail',
    durationMs: 2,
    errors: [error("Cannot find module './missing.ts'", { name: 'ImportError' })],
  },
]

/** The snapshot totals of the fixture run: one stored snapshot that differs. */
export const FIXTURE_SNAPSHOTS: SnapshotRunSummary = {
  counters: {
    added: 0,
    matched: 0,
    unmatched: 1,
    updated: 0,
    unchecked: 0,
    total: 1,
    filesAdded: 0,
    filesRemoved: 0,
    filesUnmatched: 1,
    filesUpdated: 0,
  },
  uncheckedKeysByFile: [],
  update: 'none',
  files: [],
}

/**
 * Plays `files` through the reporter `make` builds around a buffer (`out`, a new one by default),
 * checks that no reporter failed, and returns what it wrote with the run's summary.
 */
async function playInto(
  make: (out: Output) => Reporter,
  files: readonly FileSpec[],
  extra: PlayOptions,
  out: Output,
): Promise<{ readonly text: string; readonly summary: RunSummary }> {
  const bus = createReporterBus([make(out)])
  const summary = await playRun(bus, files, extra)
  assert.deepEqual(bus.failures(), [])
  return { text: out.text(), summary }
}

/** `playRun` through the reporter `make` builds around a buffer: what it wrote, and no reporter failed. */
export async function playThrough(
  make: (out: Output) => Reporter,
  files: readonly FileSpec[],
  extra: PlayOptions = {},
  out: Output = output(),
): Promise<string> {
  return (await playInto(make, files, extra, out)).text
}

/** Plays the fixture run through the reporter `make` builds around a buffer, and returns what it wrote. */
export function playFixture(
  make: (out: Output) => Reporter,
): Promise<{ readonly text: string; readonly summary: RunSummary }> {
  return playInto(make, FIXTURE_FILES, { snapshots: FIXTURE_SNAPSHOTS, durationMs: 1234 }, output())
}
