// Test helpers for the reporters' unit tests (not a test file): synthetic runs built to the real
// types. A `FileSpec` describes one file and the events it would produce; `playRun` sends a
// whole run through a bus, as the coordinator will.
import type {
  FileInfo,
  FileResult,
  FileTask,
  Reporter,
  ReporterBus,
  RunEnvironment,
  RunSummary,
  RuntimeEventOf,
  SerializedError,
  SkipReason,
  SuiteTask,
  TaskId,
  TaskNode,
  TaskResult,
  TaskState,
  TestTask,
  WorkerExit,
} from '@provino/types'

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

/** Sends one file's events, in the order the coordinator will: queued, start, collected, each test, end. */
export async function emitFile(bus: ReporterBus, spec: FileSpec): Promise<FileResult> {
  const file = buildFile(spec)
  await bus.emit('file:queued', file.info)
  await bus.emit('file:start', file.info, 0)
  await bus.emit('file:collected', file.info, collectedEvent(file))
  for (const { task, spec: testSpec } of file.tests) {
    if (testSpec.ran === false) continue
    await bus.emit('task:start', task, testStartEvent(task))
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

/** A run: `run:start`, every file, then `run:end` with a summary built from them. */
export async function playRun(
  bus: ReporterBus,
  files: readonly FileSpec[],
  options: { readonly unhandled?: readonly SerializedError[]; readonly durationMs?: number } = {},
): Promise<RunSummary> {
  const infos = files.map((spec) => fileInfo(spec.path, spec.project ?? ''))
  await bus.emit(
    'run:start',
    { root: '/project', projects: [''], startTime: 0, watch: false },
    infos,
  )
  const results: FileResult[] = []
  for (const spec of files) results.push(await emitFile(bus, spec))
  const failed = results.some((r) => r.state === 'fail')
  const summary: RunSummary = {
    reason: failed ? 'failed' : 'passed',
    files: results,
    unhandled: options.unhandled ?? [],
    durationMs: options.durationMs ?? 1234,
  }
  await bus.emit('run:end', summary)
  return summary
}

/** A buffer for a `TextSink`. */
export interface Output {
  write(chunk: string): void
  text(): string
}

export function output(): Output {
  const chunks: string[] = []
  return {
    write: (chunk) => {
      chunks.push(chunk)
    },
    text: () => chunks.join(''),
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
