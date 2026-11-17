// The synthetic event stream `bench:reporter` plays (B26 Phase 1): what a coordinator's bus would
// deliver for a big run, built to the real `ReporterEvents` types. Workers take files in waves and
// their events interleave one test at a time, as a pool's messages do. It is seeded, so two builds
// are equal, and it is built before anything is timed. The fixture's shapes are the models: a
// failed `toBe` with its diff, console writes of three kinds on 5% of the files, failures on 1% of
// the tests (or a fixed number of them, which the heap leg needs to compare two sizes fairly).
import type {
  FileInfo,
  FileResult,
  FileTask,
  ReporterEvents,
  RunSummary,
  SerializedError,
  TaskId,
  TaskResult,
  TestTask,
} from '@provino/types'
import { seededRandom } from '../internal/prng.ts'

/**
 * One bus event with its arguments, typed per event name.
 * @public
 */
export type StreamEvent = {
  readonly [K in keyof ReporterEvents]: { readonly name: K; readonly args: ReporterEvents[K] }
}[keyof ReporterEvents]

/**
 * The shape of a stream.
 * @public
 */
export interface StreamSpec {
  readonly files: number
  readonly testsPerFile: number
  /** Files running at once. */
  readonly workers: number
  readonly seed: number
  /** Share of tests that fail; ignored when `failures` is set. */
  readonly failureRate: number
  /** Exactly this many tests fail, evenly spread. */
  readonly failures?: number
  /** Share of files that write to the console. */
  readonly consoleRate: number
}

/** The stream the bars are read on: 16 workers, 2,000 files of 25 tests, 50,000 tests. */
export const DEFAULT_SPEC: StreamSpec = {
  files: 2000,
  testsPerFile: 25,
  workers: 16,
  seed: 1,
  failureRate: 0.01,
  consoleRate: 0.05,
}

/** `DEFAULT_SPEC` with about `tests` tests: the same 25 a file, more or fewer files. */
export function specForTests(tests: number, overrides: Partial<StreamSpec> = {}): StreamSpec {
  return {
    ...DEFAULT_SPEC,
    files: Math.max(1, Math.round(tests / DEFAULT_SPEC.testsPerFile)),
    ...overrides,
  }
}

const TO_BE_ERROR: SerializedError = {
  name: 'Error',
  message: 'expect(received).toBe(expected) // Object.is equality\n\nExpected: 2\nReceived: 1',
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
}

const CONSOLE_KINDS: readonly {
  readonly stream: 'stdout' | 'stderr'
  readonly level: string | null
  readonly text: string
}[] = [
  { stream: 'stdout', level: 'log', text: 'rendering the cart' },
  { stream: 'stderr', level: 'warn', text: 'deprecated: use the new API' },
  { stream: 'stdout', level: null, text: 'raw write to stdout\n' },
]

/** What a stream held, counted while it was made. */
export interface StreamCounts {
  readonly files: number
  readonly tests: number
  readonly failures: number
  readonly consoles: number
  readonly events: number
}

/**
 * A prebuilt stream: every event, ready to play.
 * @public
 */
export interface Stream {
  readonly spec: StreamSpec
  readonly events: readonly StreamEvent[]
  readonly counts: StreamCounts
}

interface FileScript {
  readonly info: FileInfo
  readonly collected: StreamEvent
  /** One test's events (and a console write, now and then) per group. */
  readonly groups: readonly (readonly StreamEvent[])[]
  readonly end: StreamEvent
  readonly failures: number
  readonly consoles: number
}

function taskId(text: string): TaskId {
  return text as TaskId
}

/** The events of file `index`: deterministic, whatever order files are built in. */
function fileScript(spec: StreamSpec, index: number, clock: { t: number }): FileScript {
  const random = seededRandom(spec.seed * 1_000_003 + index)
  const path = `src/area-${index % 40}/module-${index}.test.ts`
  const fileId = taskId(`file:${path}`)
  const info: FileInfo = { fileId, path, project: '' }
  const stride =
    spec.failures === undefined || spec.failures === 0
      ? 0
      : Math.max(1, Math.floor((spec.files * spec.testsPerFile) / spec.failures))

  const fileTask: FileTask = {
    type: 'file',
    id: fileId,
    parentId: null,
    fileId,
    name: path,
    mode: 'run',
    location: null,
    tags: [],
    meta: {},
    path,
    projectName: '',
    children: Array.from({ length: spec.testsPerFile }, (_, n) => taskId(`${fileId}:${n}`)),
  }
  const tests: TestTask[] = []
  const groups: StreamEvent[][] = []
  let failures = 0
  let fileMs = 0
  const writesConsole = random() < spec.consoleRate
  let consoles = 0
  for (let n = 0; n < spec.testsPerFile; n++) {
    const id = taskId(`${fileId}:${n}`)
    const test: TestTask = {
      type: 'test',
      id,
      parentId: fileId,
      fileId,
      name: `case ${n}`,
      mode: 'run',
      location: null,
      tags: [],
      meta: {},
      fullName: ['module', `case ${n}`],
      dupIndex: 0,
      each: false,
      concurrent: false,
      expectFail: false,
      timeoutMs: 5000,
      retry: 0,
      repeats: 0,
    }
    tests.push(test)
    const ordinal = index * spec.testsPerFile + n
    const fails =
      stride > 0
        ? ordinal % stride === 0 && ordinal / stride < (spec.failures ?? 0)
        : random() < spec.failureRate
    const skipped = !fails && random() < 0.02
    const durationMs = 1 + random() * 20
    fileMs += durationMs
    const result: TaskResult = {
      state: fails ? 'fail' : skipped ? 'skip' : 'pass',
      durationMs,
      startTime: clock.t,
      errors: fails ? [TO_BE_ERROR] : [],
      retryErrors: [],
      attempts: 1,
      repeatIndex: 0,
      assertions: 3,
      passingAssertions: fails ? 2 : 3,
    }
    if (fails) failures++
    const t = (): number => clock.t++
    const group: StreamEvent[] = [
      { name: 'task:start', args: [test, { type: 'test-start', id, t: t() }] },
      {
        name: 'test:attempt-start',
        args: [test, { type: 'test-attempt-start', id, attempt: 0, repeat: 0, t: t() }],
      },
      {
        name: 'hook:start',
        args: [
          fileTask,
          {
            type: 'hook-start',
            ownerId: fileId,
            testId: id,
            kind: 'beforeEach',
            ordinal: 0,
            location: null,
            t: t(),
          },
        ],
      },
      {
        name: 'hook:end',
        args: [
          fileTask,
          {
            type: 'hook-end',
            ownerId: fileId,
            testId: id,
            kind: 'beforeEach',
            ordinal: 0,
            error: null,
            t: t(),
          },
        ],
      },
    ]
    if (writesConsole && n === 1) {
      for (const kind of CONSOLE_KINDS) {
        consoles++
        group.push({
          name: 'console',
          args: [
            info,
            {
              type: 'console',
              taskId: id,
              stream: kind.stream,
              level: kind.level,
              text: kind.text,
              origin: null,
              t: t(),
            },
          ],
        })
      }
    }
    group.push(
      {
        name: 'test:attempt-end',
        args: [
          test,
          {
            type: 'test-attempt-end',
            id,
            attempt: 0,
            repeat: 0,
            state: result.state === 'skip' ? 'skip' : fails ? 'fail' : 'pass',
            errors: result.errors,
            willRetry: false,
            t: t(),
          },
        ],
      },
      { name: 'task:end', args: [test, { type: 'test-end', id, result, t: t() }] },
    )
    groups.push(group)
  }
  const fileResult: FileResult = {
    file: info,
    state: failures > 0 ? 'fail' : 'pass',
    durationMs: fileMs,
    errors: [],
  }
  return {
    info,
    collected: {
      name: 'file:collected',
      args: [
        info,
        { type: 'file-collect-end', fileId, tasks: [fileTask, ...tests], errors: [], t: clock.t++ },
      ],
    },
    groups,
    end: { name: 'file:end', args: [fileResult] },
    failures,
    consoles,
  }
}

/**
 * Plays the stream a file at a time as a generator, so a large run never holds it whole: `run:start`,
 * then waves of `workers` files, each wave's events interleaved one test at a time, then `run:end`.
 * @public
 */
export function* streamEvents(
  spec: StreamSpec,
  counts?: { -readonly [K in keyof StreamCounts]: number },
): Generator<StreamEvent> {
  const clock = { t: 0 }
  const infos: FileInfo[] = []
  for (let i = 0; i < spec.files; i++) {
    const path = `src/area-${i % 40}/module-${i}.test.ts`
    infos.push({ fileId: taskId(`file:${path}`), path, project: '' })
  }
  yield {
    name: 'run:start',
    args: [{ root: '/project', projects: [''], startTime: 0, watch: false, inBand: false }, infos],
  }
  for (let wave = 0; wave < spec.files; wave += spec.workers) {
    const scripts: FileScript[] = []
    for (let i = wave; i < Math.min(spec.files, wave + spec.workers); i++) {
      scripts.push(fileScript(spec, i, clock))
    }
    for (const [worker, script] of scripts.entries()) {
      yield { name: 'file:start', args: [script.info, worker] }
      yield script.collected
    }
    for (let turn = 0; ; turn++) {
      let any = false
      for (const script of scripts) {
        const group = script.groups[turn]
        if (group === undefined) continue
        any = true
        for (const event of group) yield event
      }
      if (!any) break
    }
    for (const script of scripts) {
      yield script.end
      if (counts !== undefined) {
        counts.files++
        counts.tests += script.groups.length
        counts.failures += script.failures
        counts.consoles += script.consoles
      }
    }
  }
  const summary: RunSummary = {
    reason: 'passed',
    files: [],
    unhandled: [],
    durationMs: clock.t,
  }
  yield { name: 'run:end', args: [summary] }
}

/**
 * Builds the whole stream, for the legs that time the handlers: generation is done before the clock starts.
 * @public
 */
export function buildStream(spec: StreamSpec = DEFAULT_SPEC): Stream {
  const counts = { files: 0, tests: 0, failures: 0, consoles: 0, events: 0 }
  const events = [...streamEvents(spec, counts)]
  counts.events = events.length
  return { spec, events, counts }
}
