// Runs one runtime-corpus test file through `@provino/core` (B07's temporary entry before
// `provino/node` exists, DECISIONS S4) and reduces the events to what a golden records: the trace,
// each test's title path, `dupIndex`, status and location, and the file's status.
import { pathToFileURL } from 'node:url'
import { createRuntime, type RuntimeApi } from '@provino/core'
import { createBehaviourLoader } from '@provino/policy'
import type { CorePolicy, RuntimeEvent, TaskNode, TestTask } from '@provino/types'

/** A test as the comparison sees it. */
export interface CoreTest {
  readonly path: readonly string[]
  readonly dupIndex: number
  readonly status: 'passed' | 'failed' | 'skipped' | 'todo'
  readonly location: { readonly line: number; readonly column: number } | null
}

/** One file's run under the core. */
export interface CoreRun {
  readonly trace: readonly string[]
  readonly tests: readonly CoreTest[]
  readonly fileStatus: 'passed' | 'failed' | 'crashed'
  readonly events: readonly RuntimeEvent[]
}

const GLOBALS = [
  'describe',
  'suite',
  'test',
  'it',
  'beforeAll',
  'afterAll',
  'beforeEach',
  'afterEach',
  'aroundEach',
  'aroundAll',
  'onTestFinished',
  'onTestFailed',
] as const satisfies ReadonlyArray<keyof RuntimeApi>

const STATUS = { pass: 'passed', fail: 'failed', skip: 'skipped', todo: 'todo' } as const

let imports = 0

/**
 * Runs `file` (absolute) under `policy`, with the runtime's API and `trace` installed as globals
 * for the duration, as the recorder's runners would. `rootDir` is the fixture directory.
 */
export async function runUnderCore(
  file: string,
  rootDir: string,
  policy: CorePolicy,
): Promise<CoreRun> {
  const events: RuntimeEvent[] = []
  const trace: string[] = []
  const runtime = await createRuntime({
    policy,
    behaviours: createBehaviourLoader(),
    sink: { emit: (event) => events.push(event) },
    // A fresh module instance per run: the query makes each import a new URL.
    importFile: (path) => import(`${pathToFileURL(path).href}?core-run=${++imports}`),
    rootDir,
    // The recorder runs both runners with `CI=1`.
    ci: true,
  })
  const scope = globalThis as unknown as Record<string, unknown>
  const saved = new Map<string, unknown>()
  // Like the recorder's `trace`, it returns nothing: a test arrow that returns its result must not
  // trip `nonPromiseReturn`.
  const installed: Record<string, unknown> = {
    trace: (step: string): void => {
      trace.push(step)
    },
  }
  for (const name of GLOBALS) installed[name] = runtime.api[name]
  for (const [name, value] of Object.entries(installed)) {
    saved.set(name, scope[name])
    scope[name] = value
  }
  let state: string
  try {
    state = (await runtime.runFile(file)).state
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete scope[name]
      else scope[name] = value
    }
    await runtime.dispose()
  }

  const collected = events.find((event) => event.type === 'file-collect-end')
  const tasks: readonly TaskNode[] = collected?.type === 'file-collect-end' ? collected.tasks : []
  const ends = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'test-end') ends.set(event.id, event.result.state)
  }
  const tests = tasks
    .filter((task): task is TestTask => task.type === 'test')
    .map((task): CoreTest => {
      const state = ends.get(task.id) as keyof typeof STATUS | undefined
      return {
        path: task.fullName,
        dupIndex: task.dupIndex,
        status: STATUS[state ?? 'skip'],
        location:
          task.location === null
            ? null
            : { line: task.location.line, column: task.location.column },
      }
    })
  const crashed =
    state === 'fail' &&
    tests.length === 0 &&
    collected?.type === 'file-collect-end' &&
    collected.errors.length > 0
  return {
    trace,
    tests,
    fileStatus: crashed ? 'crashed' : state === 'fail' ? 'failed' : 'passed',
    events,
  }
}
