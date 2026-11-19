// A sample run for the HTML report: what the bus would deliver for a run of app-500's shape (500
// files of 8 tests, one `describe` each, named as the bench's `app-N` suite names them), spread
// over folders and eight workers, with the fixture's failure rate (1% of the tests, with its
// error shapes) and, in some states, a file whose worker died. Seeded and timed by a clock the
// caller moves, so two plays are equal. It is for tests, the design pass (`sample-cli.ts`
// writes each state as a page) and anyone who wants a page to look at. It imports types only, so a
// script can run it with no build.

import type {
  FileInfo,
  FileResult,
  FileTask,
  ReporterBus,
  RunSummary,
  SerializedError,
  SnapshotRunSummary,
  SuiteTask,
  TaskId,
  TaskNode,
  TaskResult,
  TestTask,
  WorkerExit,
} from '@provino/types'

/** The states of the sample: what the page is shown in. */
export type SampleState = 'empty' | 'all-passed' | 'failures' | 'crashed' | '2000-files'

/** Every state, in the order `sample-cli.ts` writes them. */
export const SAMPLE_STATES: readonly SampleState[] = [
  'empty',
  'all-passed',
  'failures',
  'crashed',
  '2000-files',
]

/** The clock a sample is played on: the reporter's `now`, which `playSample` moves. */
export interface SampleClock {
  readonly now: () => number
  set(ms: number): void
}

/** A clock at 0 that only the sample moves. */
export function sampleClock(): SampleClock {
  let time = 0
  return {
    now: () => time,
    set(ms) {
      time = ms
    },
  }
}

const WORKERS = 8
const TESTS_PER_FILE = 8
const FAILURE_RATE = 0.01
const AREAS = [
  'accounts',
  'admin',
  'analytics',
  'api',
  'billing',
  'cart',
  'catalog',
  'checkout',
  'inventory',
  'notifications',
  'search',
  'shipping',
]

/** mulberry32: a small seeded generator, so a state is the same every time. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const id = (text: string): TaskId => text as TaskId
const pad = (n: number): string => String(n).padStart(4, '0')

const ERRORS: readonly ((n: number, file: string) => SerializedError)[] = [
  (n, file) => ({
    name: 'Error',
    message: `expect(received).toBe(expected) // Object.is equality\n\nExpected: ${n + 1}\nReceived: ${n}`,
    stack: [
      'Error: expect(received).toBe(expected) // Object.is equality',
      `    at Object.<anonymous> (/project/${file}:14:35)`,
      '    at Promise.then.completed (/project/node_modules/jest-circus/build/utils.js:298:28)',
    ].join('\n'),
  }),
  (n, file) => ({
    name: 'TypeError',
    message: "Cannot read properties of undefined (reading 'total')",
    stack: [
      "TypeError: Cannot read properties of undefined (reading 'total')",
      `    at summarize (/project/src/cart/summary.ts:${20 + (n % 30)}:18)`,
      `    at Object.<anonymous> (/project/${file}:22:20)`,
    ].join('\n'),
  }),
  (_n, file) => ({
    name: 'Error',
    message:
      'expect(received).toMatchSnapshot()\n\n- Snapshot  - 1\n+ Received  + 1\n\n  Object {\n-   "status": "open",\n+   "status": "closed",\n  }',
    stack: `Error: expect(received).toMatchSnapshot()\n    at Object.<anonymous> (/project/${file}:30:22)`,
  }),
  (_n, file) => ({
    name: 'Error',
    message: 'Exceeded timeout of 5000 ms for a test.',
    stack: `Error: Exceeded timeout of 5000 ms for a test.\n    at Object.<anonymous> (/project/${file}:41:3)`,
  }),
]

/** One file of the sample before it is played. */
interface SampleFile {
  readonly path: string
  readonly tests: readonly {
    readonly path: readonly string[]
    readonly state: 'pass' | 'fail' | 'skip' | 'todo'
    readonly ms: number
    readonly errors: readonly SerializedError[]
  }[]
  /** Tests that end before a crash; every test when there is no crash. */
  readonly ran: number
  readonly state: 'pass' | 'fail' | 'skip'
  readonly ms: number
  readonly errors: readonly SerializedError[]
  readonly workerExit?: WorkerExit
  readonly expectedMs?: number
}

interface Plan {
  readonly files: readonly SampleFile[]
  readonly crashAt: number
}

/** The files of a state: app-shaped files over the areas, and the special ones the state adds. */
function planFor(state: Exclude<SampleState, 'empty'>): Plan {
  const count = state === '2000-files' ? 2000 : 500
  const random = seeded(state === '2000-files' ? 2000 : 500)
  const failures = state !== 'all-passed'
  const files: SampleFile[] = []
  for (let index = 0; index < count; index++) {
    const area = AREAS[index % AREAS.length] as string
    const path = `src/${area}/app-${pad(index)}.test.ts`
    const a = `m${pad(Math.floor(random() * 20)).slice(2)}`
    const b = `m${pad(Math.floor(random() * 20)).slice(2)}`
    const titles = [
      `${a} totals ${Math.floor(random() * 900)} for n = ${1 + Math.floor(random() * 20)}`,
      `${b} totals ${Math.floor(random() * 900)} for n = ${1 + Math.floor(random() * 20)}`,
      `${a} runs its ${1 + Math.floor(random() * 30)} modules once each`,
      `${b} is within one of its total`,
      `${a} grows with its input`,
      'the global beforeEach has run for each test so far',
      'the global afterEach has run after each earlier test',
      `${b} totals ${Math.floor(random() * 900)} for n = ${1 + Math.floor(random() * 20)}`,
    ]
    const tests = titles.map((title, n) => {
      const slow = random() < 0.05
      const ms = slow ? 50 + random() * 200 : 1 + random() * 14
      const fails = failures && random() < FAILURE_RATE
      const skipped = random() < 0.01
      const make = ERRORS[Math.floor(random() * ERRORS.length)] as (typeof ERRORS)[number]
      return {
        path: [`app ${pad(index)}`, title],
        state: fails ? ('fail' as const) : skipped ? ('skip' as const) : ('pass' as const),
        ms,
        errors: fails ? [make(n, path)] : [],
      }
    })
    const ms = tests.reduce((sum, test) => sum + test.ms, 0) + 15 + random() * 60
    files.push({
      path,
      tests,
      ran: tests.length,
      state: tests.some((test) => test.state === 'fail') ? 'fail' : 'pass',
      ms,
      errors: [],
      ...(random() < 0.8 ? { expectedMs: ms * (0.8 + random() * 0.5) } : {}),
    })
  }
  if (failures) {
    const nested = (
      kind: 'pass' | 'fail' | 'skip' | 'todo',
      n: number,
    ): SampleFile['tests'][number] => ({
      path: [
        'checkout',
        n < 2 ? 'totals' : 'discounts',
        n % 2 === 0 ? 'with a coupon' : 'without one',
        `case ${n}`,
      ],
      state: kind,
      ms: 3 + n,
      errors:
        kind === 'fail'
          ? [(ERRORS[0] as (typeof ERRORS)[number])(n, 'src/checkout/nested.test.ts')]
          : [],
    })
    files.splice(40, 0, {
      path: 'src/checkout/nested.test.ts',
      tests: [
        nested('pass', 0),
        nested('fail', 1),
        nested('pass', 2),
        nested('skip', 3),
        nested('todo', 4),
        nested('fail', 5),
      ],
      ran: 6,
      state: 'fail',
      ms: 41,
      errors: [],
    })
    files.splice(120, 0, {
      path: 'src/cart/missing-import.test.ts',
      tests: [],
      ran: 0,
      state: 'fail',
      ms: 6,
      errors: [
        {
          name: 'Error',
          message:
            "Cannot find module '../src/cart/legacy.ts' from 'src/cart/missing-import.test.ts'",
          stack:
            "Error: Cannot find module '../src/cart/legacy.ts'\n    at /project/src/cart/missing-import.test.ts:1:1",
        },
      ],
    })
  }
  let crashAt = -1
  if (state === 'crashed' || state === '2000-files') {
    crashAt = 200
    files.splice(crashAt, 0, {
      path: 'src/api/native-addon.test.ts',
      tests: Array.from({ length: TESTS_PER_FILE }, (_, n) => ({
        path: ['native addon', `call ${n}`],
        state: 'pass' as const,
        ms: 4,
        errors: [],
      })),
      ran: 3,
      state: 'fail',
      ms: 180,
      errors: [
        {
          name: 'Error',
          message: 'The worker running src/api/native-addon.test.ts exited with SIGSEGV',
        },
      ],
      workerExit: { type: 'signal', signal: 'SIGSEGV', likelyOom: false },
    })
  }
  return { files, crashAt }
}

function task(
  fileId: TaskId,
  parent: TaskId,
  name: string,
  index: number,
): Pick<SuiteTask, 'id' | 'parentId' | 'fileId' | 'name' | 'mode' | 'location' | 'tags' | 'meta'> {
  return {
    id: id(`${fileId}/${index}`),
    parentId: parent,
    fileId,
    name,
    mode: 'run',
    location: null,
    tags: [],
    meta: {},
  }
}

/** The collected tree of a file: a suite for each distinct describe prefix, then the tests. */
function tree(info: FileInfo, file: SampleFile): { tasks: TaskNode[]; tests: TestTask[] } {
  const fileTask: FileTask = {
    ...task(info.fileId, info.fileId, file.path, 0),
    id: info.fileId,
    parentId: null,
    type: 'file',
    path: file.path,
    projectName: '',
    children: [],
  }
  const children = new Map<TaskId, TaskId[]>([[info.fileId, []]])
  const suites = new Map<string, SuiteTask>()
  const tasks: TaskNode[] = [fileTask]
  const tests: TestTask[] = []
  let next = 1
  const suiteFor = (path: readonly string[]): TaskId => {
    if (path.length === 0) return info.fileId
    const key = path.join('\u0000')
    const known = suites.get(key)
    if (known !== undefined) return known.id
    const parent = suiteFor(path.slice(0, -1))
    const suite: SuiteTask = {
      ...task(info.fileId, parent, path[path.length - 1] as string, next++),
      type: 'suite',
      children: [],
      each: false,
      concurrent: false,
      shuffle: false,
    }
    suites.set(key, suite)
    children.set(suite.id, [])
    children.get(parent)?.push(suite.id)
    tasks.push(suite)
    return suite.id
  }
  for (const test of file.tests) {
    const parent = suiteFor(test.path.slice(0, -1))
    const leaf: TestTask = {
      ...task(info.fileId, parent, test.path[test.path.length - 1] as string, next++),
      type: 'test',
      fullName: test.path,
      dupIndex: 0,
      each: false,
      concurrent: false,
      expectFail: false,
      timeoutMs: 5000,
      retry: 0,
      repeats: 0,
    }
    children.get(parent)?.push(leaf.id)
    tasks.push(leaf)
    tests.push(leaf)
  }
  return {
    tasks: tasks.map((node) =>
      node.type === 'test' ? node : { ...node, children: children.get(node.id) ?? [] },
    ),
    tests,
  }
}

/** A step of the simulated pool: a file starts or ends on a worker at a time. */
interface Step {
  readonly t: number
  readonly kind: 'end' | 'start'
  readonly index: number
  readonly worker: number
}

function schedule(plan: Plan, random: () => number): { steps: Step[]; end: number } {
  const free = Array.from({ length: WORKERS }, () => 0)
  const ids = Array.from({ length: WORKERS }, (_, i) => i)
  let nextId = WORKERS
  const steps: Step[] = []
  let end = 0
  plan.files.forEach((file, index) => {
    let slot = 0
    for (let i = 1; i < WORKERS; i++) if ((free[i] as number) < (free[slot] as number)) slot = i
    const start = (free[slot] as number) + random() * 4
    const stop = start + file.ms
    steps.push({ t: start, kind: 'start', index, worker: ids[slot] as number })
    steps.push({ t: stop, kind: 'end', index, worker: ids[slot] as number })
    free[slot] = stop
    end = Math.max(end, stop)
    if (index === plan.crashAt) {
      // The dead worker is replaced by one with a new id, after a gap.
      ids[slot] = nextId++
      free[slot] = stop + 250
    }
  })
  steps.sort(
    (a, b) => a.t - b.t || (a.kind === b.kind ? a.index - b.index : a.kind === 'end' ? -1 : 1),
  )
  return { steps, end }
}

const SNAPSHOTS: SnapshotRunSummary = {
  counters: {
    added: 0,
    matched: 41,
    unmatched: 1,
    updated: 0,
    unchecked: 2,
    total: 44,
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
 * Plays a sample run through `bus`, moving `clock` to each file's start and end. The state's
 * files are app-500's shape, 500 of them (2,000 for `2000-files`) over eight workers; `failures`
 * adds the fixture's failure rate, a nested file and a file that fails to collect; `crashed` and
 * `2000-files` add a file whose worker died, and an error that belongs to no file.
 */
export async function playSample(
  bus: ReporterBus,
  state: SampleState,
  clock: SampleClock,
): Promise<RunSummary> {
  clock.set(0)
  if (state === 'empty') {
    await bus.emit(
      'run:start',
      { root: '/project', projects: [''], startTime: 0, watch: false, workers: WORKERS },
      [],
    )
    clock.set(3)
    const summary: RunSummary = { reason: 'passed', files: [], unhandled: [], durationMs: 3 }
    await bus.emit('run:end', summary)
    return summary
  }
  const plan = planFor(state)
  const random = seeded(7)
  const infos = plan.files.map(
    (file): FileInfo => ({
      fileId: id(`file:${file.path}`),
      path: file.path,
      project: '',
      ...(file.expectedMs === undefined ? {} : { expectedMs: file.expectedMs }),
    }),
  )
  await bus.emit(
    'run:start',
    { root: '/project', projects: [''], startTime: 0, watch: false, workers: WORKERS },
    infos,
  )
  const { steps, end } = schedule(plan, random)
  const results: FileResult[] = []
  let late = false
  for (const step of steps) {
    const file = plan.files[step.index] as SampleFile
    const info = infos[step.index] as FileInfo
    clock.set(step.t)
    if (step.kind === 'start') {
      await bus.emit('file:start', info, step.worker)
      const { tasks, tests } = tree(info, file)
      await bus.emit('file:collected', info, {
        type: 'file-collect-end',
        fileId: info.fileId,
        tasks,
        errors: [],
        t: 0,
      })
      for (const [n, leaf] of tests.entries()) {
        if (n >= file.ran) break
        const test = file.tests[n] as SampleFile['tests'][number]
        const result: TaskResult = {
          state: test.state,
          durationMs: test.ms,
          startTime: 0,
          errors: test.errors,
          retryErrors: [],
          attempts: 1,
          repeatIndex: 0,
          assertions: 1,
          passingAssertions: test.state === 'fail' ? 0 : 1,
        }
        await bus.emit('task:end', leaf, { type: 'test-end', id: leaf.id, result, t: 0 })
      }
      continue
    }
    const result: FileResult = {
      file: info,
      state: file.state,
      durationMs: file.ms,
      errors: file.errors,
      ...(file.workerExit === undefined ? {} : { workerExit: file.workerExit }),
    }
    results.push(result)
    await bus.emit('file:end', result)
    if (
      !late &&
      (state === 'crashed' || state === '2000-files') &&
      results.length === Math.floor(plan.files.length / 2)
    ) {
      late = true
      await bus.emit('unhandled', null, {
        type: 'unhandled-error',
        ownerId: null,
        lastTestId: null,
        origin: 'unhandledRejection',
        error: {
          name: 'Error',
          message: 'connect ECONNREFUSED 127.0.0.1:5432',
          stack: 'Error: connect ECONNREFUSED 127.0.0.1:5432\n    at /project/src/api/db.ts:12:9',
        },
        t: 0,
      })
    }
  }
  clock.set(end + 5)
  const failed = results.some((result) => result.state === 'fail')
  const summary: RunSummary = {
    reason: failed ? 'failed' : 'passed',
    files: results,
    unhandled: [],
    durationMs: end + 5,
    ...(state === 'all-passed' ? {} : { snapshots: SNAPSHOTS }),
  }
  await bus.emit('run:end', summary)
  return summary
}
