// Runs one expect-corpus test file through `@provino/core` with the Jest dialect's `expect`
// (B08's temporary entry before `provino/node` exists, DECISIONS S4), in the boot order the worker
// will use (U1): state source, slot, the table loaded by `ModuleRef`, then `expect`. Each test is
// reduced to what a golden records: status, the failures' text and matcher name as Jest's JSON
// would carry them, and the passing-assertion count.
import { pathToFileURL } from 'node:url'
import { createRuntime, currentTest } from '@provino/core'
import { jestExpectPolicy, jestMockPolicy } from '@provino/dialect-jest'
import { jestGlobals } from '@provino/dialect-jest/runtime'
import {
  createExpect,
  createMatcherRegistry,
  createStateSource,
  installMatchersSlot,
  type TestRun,
} from '@provino/expect'
import { createMockRegistry, type MockRegistry } from '@provino/mock'
import { createBehaviourLoader } from '@provino/policy'
import type {
  CorePolicy,
  ExpectPolicy,
  MatcherState,
  RuntimeEvent,
  SerializedError,
  TaskId,
  TestTask,
} from '@provino/types'
import { installGlobals } from '../internal/globals.ts'
import { unusedJestHost } from '../mock-corpus/run-mock.ts'
import { type Reported, reported } from '../runtime-corpus/run-core.ts'

/** One failure of a test: what Jest's JSON holds for it. */
export interface ExpectFailure {
  /**
   * Jest's `failureMessages` entry: the error's `stack`, or its message when there is none
   * (jest-circus `getErrorStack`).
   */
  readonly text: string
  /** Jest's `failureDetails[i].matcherResult.name`; absent for an error no matcher made. */
  readonly matcher?: string
}

/** A test as the comparison sees it. */
export interface ExpectTest {
  readonly path: readonly string[]
  readonly dupIndex: number
  readonly status: Reported
  readonly failures: readonly ExpectFailure[]
  readonly passingAssertions: number
}

/** Jest's `failureMessages` entry for one error (jest-circus `utils.ts` `getErrorStack`). */
function failureText(error: SerializedError): string {
  return typeof error.stack === 'string' && error.stack !== '' ? error.stack : error.message
}

function failureOf(error: SerializedError): ExpectFailure {
  const matcher = error.matcherResult?.name
  return { text: failureText(error), ...(matcher === undefined ? {} : { matcher }) }
}

/**
 * Runs `file` (absolute; imported once per process, so its frames are plain `file:` URLs) under
 * `policy`, with `expect` built from `options.expectPolicy` (the Jest dialect's by default; T1.7
 * passes a flipped one). `runtime.api`, `expect` and `jest` (the one `jestGlobals` ships, over a
 * `@provino/mock` registry under `jestMockPolicy`) are globals for the duration.
 */
export async function runExpectFile(
  file: string,
  rootDir: string,
  policy: CorePolicy,
  options: ExpectRunOptions = {},
): Promise<readonly ExpectTest[]> {
  const expectPolicy = options.expectPolicy ?? jestExpectPolicy
  const query = options.importQuery === undefined ? '' : `?${options.importQuery}`
  const behaviours = createBehaviourLoader()
  const source = createStateSource(currentTest, {
    nameSeparator: policy.nameSeparator,
    expand: expectPolicy.expand,
  })
  const registry = createMatcherRegistry()
  const slot = installMatchersSlot(source, registry)
  const events: RuntimeEvent[] = []
  let mocks: MockRegistry | undefined
  try {
    if (expectPolicy.matcherTable === null)
      throw new Error('the expect corpus needs a matcher table')
    const table = (await behaviours.load(expectPolicy.matcherTable))()
    const expect = createExpect({ policy: expectPolicy, table, source, registry })
    const mockRegistry = createMockRegistry()
    mocks = mockRegistry
    const runtime = await createRuntime({
      policy,
      behaviours,
      sink: { emit: (event) => events.push(event) },
      importFile: (path) => import(`${pathToFileURL(path).href}${query}`),
      rootDir,
      ci: true,
    })
    const restore = installGlobals({
      ...runtime.api,
      expect,
      jest: jestGlobals({
        ...unusedJestHost(runtime.api, mockRegistry, jestMockPolicy, 'the expect corpus'),
        expect,
      }).jest,
    })
    try {
      source.startFile(file)
      try {
        await runtime.runFile(file)
      } finally {
        await runtime.dispose()
      }
    } finally {
      restore()
    }
  } finally {
    // A restorer that throws must not leave the matcher slot installed.
    try {
      mocks?.dispose()
    } finally {
      slot.uninstall()
    }
  }

  const tests = summarizeExpectRun(events, (id, run) => source.stateOf(id, run))
  if (query === '') return tests
  // The query names this import, not the file: the frames a failure prints lose it again.
  return tests.map((test) => ({
    ...test,
    failures: test.failures.map((failure) => ({
      ...failure,
      text: failure.text.replaceAll(query, ''),
    })),
  }))
}

/**
 * How `runExpectFile` runs a file: under which expect policy, and with which query on its import
 * URL. A process imports a file once, so a second run of the same file needs a query of its own;
 * the frames a failure prints lose it again.
 */
export interface ExpectRunOptions {
  readonly expectPolicy?: ExpectPolicy
  readonly importQuery?: string
}

/**
 * Reduces what core emitted for one file to the tests a golden compares. A test's passing count is
 * its deciding run's: the last `test-attempt-end` (Jest counts `numPassingAsserts` for it). A test
 * that ran but reported no attempt throws, rather than reading as 0 passing assertions.
 */
export function summarizeExpectRun(
  events: readonly RuntimeEvent[],
  stateOf: (id: TaskId, run: TestRun) => MatcherState | undefined,
): ExpectTest[] {
  const tests = new Map<TaskId, TestTask>()
  const lastRun = new Map<TaskId, TestRun>()
  for (const event of events) {
    if (event.type === 'file-collect-end') {
      for (const task of event.tasks) if (task.type === 'test') tests.set(task.id, task)
    } else if (event.type === 'test-attempt-end') {
      lastRun.set(event.id, event)
    }
  }
  const results: ExpectTest[] = []
  for (const event of events) {
    if (event.type !== 'test-end') continue
    const task = tests.get(event.id)
    if (task === undefined) continue
    const status = reported(event.result.state)
    const run = lastRun.get(event.id)
    if (run === undefined && status !== 'skipped' && status !== 'todo') {
      throw new Error(`expect corpus: ${task.fullName.join(' › ')} ended with no attempt`)
    }
    results.push({
      path: task.fullName,
      dupIndex: task.dupIndex,
      status,
      failures: event.result.errors.map(failureOf),
      passingAssertions: run === undefined ? 0 : (stateOf(event.id, run)?.numPassingAsserts ?? 0),
    })
  }
  return results
}
