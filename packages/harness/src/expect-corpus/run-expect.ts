// Runs one expect-corpus test file through `@provino/core` with the Jest dialect's `expect`
// (B08's temporary entry before `provino/node` exists, DECISIONS S4), in the boot order the worker
// will use (U1): state source, slot, the table loaded by `ModuleRef`, then `expect`. Each test is
// reduced to what a golden records: status, the failures' text as Jest's JSON would carry it, and
// the passing-assertion count.
import { pathToFileURL } from 'node:url'
import { createRuntime, currentTest } from '@provino/core'
import { jestExpectPolicy } from '@provino/dialect-jest'
import {
  createExpect,
  createMatcherRegistry,
  createStateSource,
  installMatchersSlot,
} from '@provino/expect'
import { createBehaviourLoader } from '@provino/policy'
import type { CorePolicy, RuntimeEvent, SerializedError, TaskId, TestTask } from '@provino/types'
import { ModuleMocker } from 'jest-mock'

/** A test as the comparison sees it. */
export interface ExpectTest {
  readonly path: readonly string[]
  readonly dupIndex: number
  readonly status: 'passed' | 'failed' | 'skipped' | 'todo' | 'no-result'
  /**
   * Each failure as Jest's `failureMessages` holds it: the error's `stack`, or its message when
   * there is none (jest-circus `getErrorStack`).
   */
  readonly failures: readonly string[]
  readonly passingAssertions: number
}

/** Jest's `failureMessages` entry for one error (jest-circus `utils.ts` `getErrorStack`). */
function failureText(error: SerializedError): string {
  return typeof error.stack === 'string' && error.stack !== '' ? error.stack : error.message
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
  const scope = globalThis as unknown as Record<string, unknown>
  const saved = new Map<string, unknown>()
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
    const installed: Record<string, unknown> = {
      ...runtime.api,
      expect,
      jest: { fn: mocker.fn.bind(mocker), spyOn: mocker.spyOn.bind(mocker) },
    }
    for (const [name, value] of Object.entries(installed)) {
      saved.set(name, scope[name])
      scope[name] = value
    }
    source.startFile(file)
    try {
      await runtime.runFile(file)
    } finally {
      await runtime.dispose()
    }
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete scope[name]
      else scope[name] = value
    }
    slot.uninstall()
  }

  const tests = new Map<TaskId, TestTask>()
  for (const event of events) {
    if (event.type !== 'file-collect-end') continue
    for (const task of event.tasks) if (task.type === 'test') tests.set(task.id, task)
  }
  const results: ExpectTest[] = []
  for (const event of events) {
    if (event.type !== 'test-end') continue
    const task = tests.get(event.id)
    if (task === undefined) continue
    results.push({
      path: task.fullName,
      dupIndex: task.dupIndex,
      status: statusOf(event.result.state),
      failures: event.result.errors.map(failureText),
      passingAssertions: source.stateOf(event.id)?.numPassingAsserts ?? 0,
    })
  }
  return results
}

function statusOf(state: string): ExpectTest['status'] {
  switch (state) {
    case 'pass':
      return 'passed'
    case 'fail':
      return 'failed'
    case 'skip':
      return 'skipped'
    case 'todo':
      return 'todo'
    default:
      return 'no-result'
  }
}
