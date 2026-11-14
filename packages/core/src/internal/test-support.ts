// Test helpers for core's own unit tests (not a test file): run an inline "file" through a real
// runtime under the neutral policy plus overrides, and read back the events, a step trace and
// each test's final state.
import { readFileSync } from 'node:fs'
import {
  type BehaviourLoader,
  createBehaviourLoader,
  isModuleRef,
  moduleRef,
  resolvePolicy,
} from '@provino/policy'
import type {
  AnyFunction,
  Behaviour,
  CorePolicy,
  ModuleRef,
  OrderHooks,
  PolicyOverrides,
  RuntimeEvent,
  RuntimeEventOf,
  RuntimeEventType,
  SuiteTask,
  TaskId,
  TaskNode,
  TaskResult,
  TestTask,
} from '@provino/types'
import type { Clock } from '@sinonjs/fake-timers'
import type { RuntimeApi } from '../collector/api.ts'
import type { RealTimers } from '../executor/deadline.ts'
import {
  createRuntime,
  type RunFileOptions,
  type Runtime,
  type RuntimeOptions,
} from '../runtime.ts'

/** A partial `core` slice: groups of keys merge key by key into the neutral values. */
export type CoreOverrides = NonNullable<PolicyOverrides['core']>

/**
 * The neutral `core` slice with `overrides` layered on by `resolvePolicy`, so a misspelled key
 * throws `POLICY_UNKNOWN_KEY` instead of being ignored.
 */
export function policyWith(overrides: CoreOverrides = {}): CorePolicy {
  return resolvePolicy({ core: overrides }).core
}

/** What one run produced. */
export interface ScriptRun {
  readonly runtime: Runtime
  readonly events: readonly RuntimeEvent[]
  /** Steps the script recorded with `step()`, in order. */
  readonly trace: readonly string[]
  readonly file: TaskResult
  readonly tasks: readonly TaskNode[]
  /** Each test's final state by its full name joined with ` > `. */
  readonly states: Readonly<Record<string, string>>
  /** Each test's error messages by full name. */
  readonly errors: Readonly<Record<string, readonly string[]>>
  /** Each test's final result by full name. */
  readonly results: Readonly<Record<string, TaskResult>>
  /** Each suite's final result by its names joined with ` > `. */
  readonly suites: Readonly<Record<string, TaskResult>>
  /** Each task's path (names below the file joined with ` > `; the file's is `file`). */
  readonly paths: ReadonlyMap<TaskId, string>
}

/**
 * A script: registers tests through `api`, recording steps with `step`. `runtime` is the runtime
 * running it, for scripts that need `lazyHost` or `currentTest`.
 */
export type Script = (api: RuntimeApi, step: (name: string) => void, runtime: Runtime) => unknown

/** Runs `script` as one test file under `policy`; `lines` and `fileId` go to that file's `runFile`. */
export async function runScript(
  script: Script,
  overrides: CoreOverrides = {},
  options: Partial<RuntimeOptions> & RunFileOptions = {},
): Promise<ScriptRun> {
  const { lines, fileId, collectOnly, shuffleSeed, lifecycle, ...runtimeOptions } = options
  const events: RuntimeEvent[] = []
  const trace: string[] = []
  const step = (name: string): void => {
    trace.push(name)
  }
  let api: RuntimeApi | undefined
  const runtime: Runtime = await createRuntime({
    policy: policyWith(overrides),
    behaviours: createBehaviourLoader(),
    sink: { emit: (event) => events.push(event) },
    importFile: async () => {
      if (api === undefined) throw new Error('the runtime is not ready')
      return script(api, step, runtime)
    },
    rootDir: '/project',
    locations: false,
    ...runtimeOptions,
  })
  api = runtime.api
  // A deadline's timer never holds the process open (the worker's port does, in a run), so
  // without a handle of its own a test that waits out a real deadline lets the event loop drain
  // under `node --test` on Node 22 ("Promise resolution is still pending").
  const keepAlive = setInterval(() => {}, 60_000)
  let file: Awaited<ReturnType<Runtime['runFile']>>
  try {
    file = await runtime.runFile('/project/script.test.ts', {
      ...(lines === undefined ? {} : { lines }),
      ...(fileId === undefined ? {} : { fileId }),
      ...(collectOnly === undefined ? {} : { collectOnly }),
      ...(shuffleSeed === undefined ? {} : { shuffleSeed }),
      ...(lifecycle === undefined ? {} : { lifecycle }),
    })
  } finally {
    clearInterval(keepAlive)
  }
  const collected = events.find((event) => event.type === 'file-collect-end')
  const tasks = collected?.type === 'file-collect-end' ? collected.tasks : []
  const byId = new Map(
    tasks.filter((task): task is TestTask => task.type === 'test').map((task) => [task.id, task]),
  )
  const states: Record<string, string> = {}
  const errors: Record<string, string[]> = {}
  const results: Record<string, TaskResult> = {}
  const suites: Record<string, TaskResult> = {}
  const paths = taskPaths(tasks)
  for (const event of events) {
    if (event.type === 'suite-end') {
      const path = paths.get(event.id)
      if (path !== undefined) suites[path] = event.result
      continue
    }
    if (event.type !== 'test-end') continue
    const test = byId.get(event.id)
    if (test === undefined) continue
    const name = test.fullName.join(' > ')
    states[name] = event.result.state
    errors[name] = event.result.errors.map((error) => error.message)
    results[name] = event.result
  }
  return { runtime, events, trace, file, tasks, states, errors, results, suites, paths }
}

/** The events of one type, in order. */
export function eventsOf<Type extends RuntimeEventType>(
  events: readonly RuntimeEvent[],
  type: Type,
): Array<RuntimeEventOf<Type>> {
  return events.filter((event): event is RuntimeEventOf<Type> => event.type === type)
}

/** The collected test with this full name (names joined with ` > `). */
export function testNamed(run: ScriptRun, name: string): TestTask {
  const found = testsOf(run.tasks).find((task) => task.fullName.join(' > ') === name)
  if (found === undefined) throw new Error(`no test named "${name}"`)
  return found
}

/** The collected suite with this path (names joined with ` > `). */
export function suiteNamed(run: ScriptRun, path: string): SuiteTask {
  const found = run.tasks.find(
    (task): task is SuiteTask => task.type === 'suite' && run.paths.get(task.id) === path,
  )
  if (found === undefined) throw new Error(`no suite named "${path}"`)
  return found
}

/** The tests of a collected tree. */
export function testsOf(tasks: readonly TaskNode[]): TestTask[] {
  return tasks.filter((task): task is TestTask => task.type === 'test')
}

/** The `orderHooks` policy value that `loaderWithOrderHooks` answers. */
export const ORDER_HOOKS_REF: ModuleRef<OrderHooks> = moduleRef<OrderHooks>(
  'test:order-hooks',
  'orderHooks',
)

/**
 * A behaviour loader that returns `orderHooks` for `ORDER_HOOKS_REF` and the real loader's
 * answer (the neutral `formatEachTitle`) for everything else.
 */
export function loaderWithOrderHooks(orderHooks: OrderHooks): BehaviourLoader {
  const real = createBehaviourLoader()
  return {
    async load<Fn extends AnyFunction>(behaviour: Behaviour<Fn>): Promise<Fn> {
      if (isModuleRef(behaviour) && behaviour.module === ORDER_HOOKS_REF.module) {
        return orderHooks as unknown as Fn
      }
      return real.load(behaviour)
    },
  }
}

/** Lets promises that are already settled run their continuations (microtasks, no timers). */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
}

/**
 * Waits until the code under test has signalled, or the run it belongs to has ended, which
 * means it never will. A test that waits on a signal uses this, so a regression that stops the
 * signal fails the test instead of hanging it.
 */
export async function reached(signal: Promise<unknown>, running: Promise<unknown>): Promise<void> {
  await Promise.race([signal, running])
}

/** Tracks whether a promise has settled, without waiting for it. */
export function watch(promise: Promise<unknown>): { readonly settled: boolean } {
  const state = { settled: false }
  const done = (): void => {
    state.settled = true
  }
  promise.then(done, done)
  return state
}

/** Runtime options that put deadlines and `now` on a fake clock. */
export function clockOptions(clock: Clock): Pick<RuntimeOptions, 'realTimers' | 'now'> {
  return { realTimers: timersOf(clock), now: () => clock.now }
}

/** The timers a fake clock provides, shaped for `RuntimeOptions.realTimers`. */
export function timersOf(clock: Clock): RealTimers {
  return {
    setTimeout: clock.setTimeout.bind(clock) as unknown as RealTimers['setTimeout'],
    clearTimeout: clock.clearTimeout.bind(clock) as unknown as RealTimers['clearTimeout'],
  }
}

/**
 * Wraps `timers` to keep every timer they create, so a test can count the ones that would still
 * hold the process open (a fake clock's timers answer `hasRef()`).
 */
export function trackRefs(timers: RealTimers): {
  readonly timers: RealTimers
  readonly created: () => number
  readonly refed: () => number
} {
  const created: unknown[] = []
  const setTimeout = (handler: () => void, ms?: number): unknown => {
    const timer = timers.setTimeout(handler, ms)
    created.push(timer)
    return timer
  }
  const holds = (timer: unknown): boolean =>
    typeof timer === 'object' &&
    timer !== null &&
    (timer as { hasRef?: () => boolean }).hasRef?.() !== false
  return {
    timers: {
      setTimeout: setTimeout as unknown as RealTimers['setTimeout'],
      clearTimeout: timers.clearTimeout,
    },
    created: () => created.length,
    refed: () => created.filter(holds).length,
  }
}

/**
 * Where a call sits in a source file. `marker` is a comment on its own line just above the call
 * (a formatter moves a trailing comment off a multi-line call, so put it above); the result is
 * the first line from there that contains `token`, and the 1-based column of `token` on it. Lets
 * a test assert a collected location without counting lines by hand.
 */
export function locateMarker(
  file: string,
  marker: string,
  token: string,
): { readonly file: string; readonly line: number; readonly column: number } {
  const lines = readFileSync(file, 'utf8').split('\n')
  const start = lines.findIndex((line) => line.trim() === marker)
  if (start < 0) throw new Error(`no line is the marker ${marker}`)
  for (let index = start + 1; index < lines.length; index++) {
    const text = lines[index] ?? ''
    if (text.includes(token)) return { file, line: index + 1, column: text.indexOf(token) + 1 }
  }
  throw new Error(`no line after ${marker} contains ${token}`)
}

/** Each task's path (names from below the file down, joined with ` > `); the file's is `file`. */
function taskPaths(tasks: readonly TaskNode[]): Map<TaskId, string> {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const paths = new Map<TaskId, string>()
  for (const task of tasks) {
    const names: string[] = []
    for (let node: TaskNode | undefined = task; node?.parentId != null; ) {
      names.unshift(node.name)
      node = byId.get(node.parentId)
    }
    paths.set(task.id, names.length === 0 ? 'file' : names.join(' > '))
  }
  return paths
}

/**
 * The run's events as one short line each, tasks named by path, so a test can assert the whole
 * protocol: `hook-start beforeEach#0 owner=a test=a > t`, `attempt-end a > t 0/0 fail will-retry`.
 */
export function eventLog(run: Pick<ScriptRun, 'events' | 'paths'>): string[] {
  const { paths } = run
  const at = (id: TaskId | null): string => (id === null ? '-' : (paths.get(id) ?? id))
  return run.events.map((event): string => {
    switch (event.type) {
      case 'suite-start':
      case 'test-start':
        return `${event.type} ${at(event.id)}`
      case 'suite-end':
      case 'test-end':
        return `${event.type} ${at(event.id)} ${event.result.state}`
      case 'test-attempt-start':
        return `attempt-start ${at(event.id)} ${event.attempt}/${event.repeat}`
      case 'test-attempt-end':
        return `attempt-end ${at(event.id)} ${event.attempt}/${event.repeat} ${event.state}${
          event.willRetry ? ' will-retry' : ''
        }`
      case 'hook-start':
      case 'hook-end':
        return `${event.type} ${event.kind}#${event.ordinal} owner=${at(event.ownerId)} test=${at(
          event.testId,
        )}${event.type === 'hook-end' && event.error !== null ? ' failed' : ''}`
      default:
        return event.type
    }
  })
}
