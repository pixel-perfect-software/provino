import type {
  FileInfo,
  FileResult,
  Reporter,
  ReportPolicy,
  RunSummary,
  SerializedError,
  TaskId,
  TaskNode,
  TaskState,
} from '@provino/types'
import type { TextSink } from '../sink.ts'
import {
  failLine,
  failureBlock,
  obsoleteBlock,
  passLine,
  skipLine,
  snapshotLine,
  summaryLines,
  type TestCounts,
  testTitle,
} from './format.ts'

/**
 * Options for `defaultReporter`.
 * @public
 */
export interface DefaultReporterOptions {
  readonly stream: TextSink
  /** The `report` slice: the title separator and the failure bullet. */
  readonly report: ReportPolicy
}

/** A test, or a suite with errors of its own, that failed; kept until its file ends. */
interface FailedTest {
  readonly title: string
  readonly errors: readonly SerializedError[]
}

/** How an `error` event is labelled, by where it came from. */
const ERROR_LABELS = {
  coordinator: 'Run error',
  reporter: 'Reporter error',
  globalSetup: 'Global setup error',
} as const

/**
 * The default reporter: Jest-like text, no colour and no live view. Per file, a `PASS` or `FAIL`
 * line and, for a failure, each failed test's title with its errors; at the end `Test Suites:`,
 * `Tests:` and `Time:`. It keeps its tallies in the closure, so one reporter serves one run at a
 * time and starts over at each `run:start`.
 * @public
 */
export function defaultReporter(options: DefaultReporterOptions): Reporter {
  const { stream, report } = options
  let state = freshState()
  // Whether the last thing printed ended in a blank line, so the totals don't add a second.
  let atBlank = true

  async function print(text: string): Promise<void> {
    atBlank = text.endsWith('\n')
    await stream.write(`${text}\n`)
  }

  return {
    name: 'default',

    'run:start'() {
      state = freshState()
    },

    // Kept until the file ends: a suite's name path is only built if that suite failed.
    'file:collected'(file, event) {
      state.collected.set(file.fileId, event.tasks)
    },

    'task:end'(task, event) {
      if (task.type === 'suite' && event.type === 'suite-end') {
        const { state: suiteState, errors } = event.result
        if (suiteState !== 'fail' || errors.length === 0) return
        const path = suitePath(state.collected.get(task.fileId), task) ?? [task.name]
        push(state.suiteFailures, task.fileId, { title: testTitle(report, path), errors })
        return
      }
      if (task.type !== 'test' || event.type !== 'test-end') return
      const { state: testState, errors } = event.result
      state.tests = tally(state.tests, testState)
      if (testState !== 'fail') return
      push(state.failures, task.fileId, { title: testTitle(report, task.fullName), errors })
    },

    async 'file:end'(result) {
      const { fileId } = result.file
      state.files = tally(state.files, result.state)
      const failed = state.failures.get(fileId) ?? []
      const failedSuites = state.suiteFailures.get(fileId) ?? []
      state.failures.delete(fileId)
      state.suiteFailures.delete(fileId)
      state.collected.delete(fileId)
      await print(fileText(result.file, result, failed, failedSuites))
    },

    async error(error, origin) {
      await print(failureBlock(report, ERROR_LABELS[origin], [error]))
    },

    async 'run:end'(summary: RunSummary) {
      const unhandled = summary.unhandled.map((error) =>
        failureBlock(report, 'Unhandled error', [error]),
      )
      const obsolete = obsoleteBlock(summary.snapshots)
      const parts = [
        ...unhandled,
        ...(obsolete === '' ? [] : [obsolete]),
        summaryLines(state.files, state.tests, summary.durationMs, snapshotLine(summary.snapshots)),
      ]
      await print((atBlank ? parts : ['', ...parts]).join('\n'))
    },
  }

  function fileText(
    file: FileInfo,
    result: FileResult,
    failed: readonly FailedTest[],
    failedSuites: readonly FailedTest[],
  ): string {
    if (result.state === 'skip') return skipLine(file.path)
    if (result.state === 'pass') return passLine(file.path, result.durationMs)
    const blocks = [...failed, ...failedSuites].map((test) =>
      failureBlock(report, test.title, test.errors),
    )
    if (result.errors.length > 0) {
      const title =
        failed.length + failedSuites.length === 0
          ? 'Test suite failed to run'
          : 'Errors outside the tests'
      blocks.push(failureBlock(report, title, result.errors))
    }
    return [failLine(file.path), ...blocks].join('\n')
  }
}

/** Everything one run accumulates; `run:start` replaces it whole. */
interface RunState {
  failures: Map<TaskId, FailedTest[]>
  /** Suites that ended `fail` with errors of their own, kept like failed tests. */
  suiteFailures: Map<TaskId, FailedTest[]>
  /** Each file's collected tasks, from `file:collected` until its `file:end`. */
  collected: Map<TaskId, readonly TaskNode[]>
  /** File tallies (`todo` stays 0) and test tallies. */
  files: TestCounts
  tests: TestCounts
}

function freshState(): RunState {
  return {
    failures: new Map(),
    suiteFailures: new Map(),
    collected: new Map(),
    files: zeroCounts(),
    tests: zeroCounts(),
  }
}

function zeroCounts(): TestCounts {
  return { failed: 0, skipped: 0, passed: 0, total: 0, todo: 0 }
}

/** Adds `item` to `map`'s list for `id`, creating the list first. */
function push<T>(map: Map<TaskId, T[]>, id: TaskId, item: T): void {
  const list = map.get(id)
  if (list === undefined) map.set(id, [item])
  else list.push(item)
}

/** The names from the root suite down to `suite`, or `undefined` when its file's tree is unknown. */
function suitePath(
  tasks: readonly TaskNode[] | undefined,
  suite: TaskNode,
): readonly string[] | undefined {
  if (tasks === undefined) return undefined
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const path: string[] = []
  for (let at: TaskNode | undefined = suite; at?.type === 'suite'; ) {
    path.unshift(at.name)
    at = at.parentId === null ? undefined : byId.get(at.parentId)
  }
  return path
}

/** One more finished file or test in `state`'s bucket. */
function tally(counts: TestCounts, state: TaskState): TestCounts {
  const total = counts.total + 1
  switch (state) {
    case 'pass':
      return { ...counts, passed: counts.passed + 1, total }
    case 'fail':
      return { ...counts, failed: counts.failed + 1, total }
    case 'skip':
      return { ...counts, skipped: counts.skipped + 1, total }
    case 'todo':
      return { ...counts, todo: counts.todo + 1, total }
    case 'queued':
    case 'running':
      // A test that ends in either never ran, so it is not counted.
      return counts
  }
}
