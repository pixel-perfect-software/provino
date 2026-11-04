// Runs one expect-corpus test file through `@provino/core` with the Jest dialect's `expect`
// (B08's temporary entry before `provino/node` exists, DECISIONS S4), in the boot order the worker
// will use (U1): state source, slot, the table loaded by `ModuleRef`, then `expect`. Each test is
// reduced to what a golden records: status, the failures' text and matcher name as Jest's JSON
// would carry them, and the passing-assertion count.
import { pathToFileURL } from 'node:url'
import { createRuntime, currentTest } from '@provino/core'
import { jestExpectPolicy } from '@provino/dialect-jest'
import {
  createExpect,
  createMatcherRegistry,
  createStateSource,
  installMatchersSlot,
  type TestRun,
} from '@provino/expect'
import { createBehaviourLoader } from '@provino/policy'
import type {
  CorePolicy,
  MatcherState,
  RuntimeEvent,
  SerializedError,
  TaskId,
  TestTask,
} from '@provino/types'
import { ModuleMocker } from 'jest-mock'
import { installGlobals } from '../internal/globals.ts'
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
 * `policy`. `runtime.api`, `expect` and `jest` (`fn`, `spyOn` from `jest-mock`, until
 * `@provino/mock`) are globals for the duration.
 */
export async function runExpectFile(
  file: string,
  rootDir: string,
  policy: CorePolicy,
): Promise<readonly ExpectTest[]> {
  const behaviours = createBehaviourLoader()
  const source = createStateSource(currentTest, {
    nameSeparator: policy.nameSeparator,
    expand: jestExpectPolicy.expand,
  })
  const registry = createMatcherRegistry()
  const slot = installMatchersSlot(source, registry)
  const events: RuntimeEvent[] = []
  try {
    if (jestExpectPolicy.matcherTable === null) throw new Error('the Jest dialect has a table')
    const table = (await behaviours.load(jestExpectPolicy.matcherTable))()
    const expect = createExpect({ policy: jestExpectPolicy, table, source, registry })
    const mocker = new ModuleMocker(globalThis)
    const runtime = await createRuntime({
      policy,
      behaviours,
      sink: { emit: (event) => events.push(event) },
      importFile: (path) => import(pathToFileURL(path).href),
      rootDir,
      ci: true,
    })
    const restore = installGlobals({
      ...runtime.api,
      expect,
      jest: { fn: mocker.fn.bind(mocker), spyOn: mocker.spyOn.bind(mocker) },
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
    slot.uninstall()
  }

  return summarizeExpectRun(events, (id, run) => source.stateOf(id, run))
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
