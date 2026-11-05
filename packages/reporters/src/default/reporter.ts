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
  type FileCounts,
  failLine,
  failureBlock,
  passLine,
  skipLine,
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
  let failures = new Map<TaskId, FailedTest[]>()
  // Suites that ended `fail` with errors of their own, kept like failed tests, and each suite's
  // name path (from the collected tree) for their titles.
  let suiteFailures = new Map<TaskId, FailedTest[]>()
  let suitePaths = new Map<TaskId, readonly string[]>()
  let files = zeroFiles()
  let tests = zeroTests()
  // Whether the last thing printed ended in a blank line, so the totals don't add a second.
  let atBlank = true

  async function print(text: string): Promise<void> {
    atBlank = text.endsWith('\n')
    await stream.write(`${text}\n`)
  }

  return {
    name: 'default',

    'run:start'() {
      failures = new Map()
      suiteFailures = new Map()
      suitePaths = new Map()
      files = zeroFiles()
      tests = zeroTests()
    },

    'file:collected'(_file, event) {
      const byId = new Map(event.tasks.map((task) => [task.id, task]))
      for (const task of event.tasks) {
        if (task.type !== 'suite') continue
        const path: string[] = []
        for (let at: TaskNode | undefined = task; at?.type === 'suite'; ) {
          path.unshift(at.name)
          at = at.parentId === null ? undefined : byId.get(at.parentId)
        }
        suitePaths.set(task.id, path)
      }
    },

    'task:end'(task, event) {
      if (task.type === 'suite' && event.type === 'suite-end') {
        const { state, errors } = event.result
        if (state !== 'fail' || errors.length === 0) return
        const failed = suiteFailures.get(task.fileId) ?? []
        failed.push({ title: testTitle(report, suitePaths.get(task.id) ?? [task.name]), errors })
        suiteFailures.set(task.fileId, failed)
        return
      }
      if (task.type !== 'test' || event.type !== 'test-end') return
      const { state, errors } = event.result
      tests = tally(tests, state)
      if (state !== 'fail') return
      const failed = failures.get(task.fileId) ?? []
      failed.push({ title: testTitle(report, task.fullName), errors })
      failures.set(task.fileId, failed)
    },

    async 'file:end'(result) {
      files = tallyFile(files, result)
      const failed = failures.get(result.file.fileId) ?? []
      failures.delete(result.file.fileId)
      const failedSuites = suiteFailures.get(result.file.fileId) ?? []
      suiteFailures.delete(result.file.fileId)
      await print(fileText(result.file, result, failed, failedSuites))
    },

    async error(error, origin) {
      await print(failureBlock(report, ERROR_LABELS[origin], [error]))
    },

    async 'run:end'(summary: RunSummary) {
      const unhandled = summary.unhandled.map((error) =>
        failureBlock(report, 'Unhandled error', [error]),
      )
      const parts = [...unhandled, summaryLines(files, tests, summary.durationMs)]
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

function zeroFiles(): FileCounts {
  return { failed: 0, skipped: 0, passed: 0, total: 0 }
}

function zeroTests(): TestCounts {
  return { ...zeroFiles(), todo: 0 }
}

function tallyFile(counts: FileCounts, result: FileResult): FileCounts {
  const total = counts.total + 1
  switch (result.state) {
    case 'pass':
      return { ...counts, passed: counts.passed + 1, total }
    case 'fail':
      return { ...counts, failed: counts.failed + 1, total }
    case 'skip':
      return { ...counts, skipped: counts.skipped + 1, total }
  }
}

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
