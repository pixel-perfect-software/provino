import { resolve } from 'node:path'
import type {
  FileInfo,
  FileResult,
  Reporter,
  ReportPolicy,
  RunSummary,
  SerializedError,
  TaskId,
} from '@provino/types'
import { createCollector, type RunRecord } from '../internal/collect.ts'
import { writeAtomically } from '../internal/write-file.ts'
import type { FileRecord } from '../normalized-json/build.ts'
import type { TextSink } from '../sink.ts'
import { formatError } from '../text/format.ts'
import { type Element, write } from './xml.ts'

/**
 * Options for `junitReporter`.
 * @public
 */
export interface JUnitReporterOptions {
  /** The `report` slice: the separator that joins a test's `describe` titles and its own. */
  readonly report: ReportPolicy
  /** Where the XML goes. It wins over `stream`; its directory is created. */
  readonly outputFile?: string
  /** Where it goes without an `outputFile`. Default: `process.stdout`. */
  readonly stream?: TextSink
  /** The `name` of `<testsuites>`. Default `provino`. */
  readonly name?: string
  /** The wall clock, in epoch milliseconds, for each suite's `timestamp`. Default `Date.now`. */
  readonly now?: () => number
}

/** Seconds as the schema's `time` has them: at most three decimals. */
function seconds(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3)
}

/** The first line of a message, for the `message` attribute. */
function firstLine(text: string): string {
  return text.split('\n')[0] ?? ''
}

/** A failure or error element for `errors`: the first error's message and name, all of them as text. */
function problem(kind: 'failure' | 'error', errors: readonly SerializedError[]): Element {
  const [first] = errors
  return {
    name: kind,
    attributes: {
      message: first === undefined ? '' : firstLine(first.message),
      type: first?.name ?? 'Error',
    },
    text: errors.map((error) => formatError(error)).join('\n\n'),
  }
}

/** Console writes as `system-out` and `system-err` elements: each stream's text in order. */
function consoleElements(entries: readonly { stream: string; text: string }[]): Element[] {
  const out = entries.filter((entry) => entry.stream === 'stdout').map((entry) => entry.text)
  const err = entries.filter((entry) => entry.stream === 'stderr').map((entry) => entry.text)
  return [
    ...(out.length === 0 ? [] : [{ name: 'system-out', text: out.join('') }]),
    ...(err.length === 0 ? [] : [{ name: 'system-err', text: err.join('') }]),
  ]
}

/** What one `<testsuite>` adds up to. */
interface SuiteElement {
  readonly element: Element
  readonly tests: number
  readonly failures: number
  readonly errors: number
  readonly skipped: number
}

/** The file's `<testsuite>`, from what the run recorded of it. */
function suiteOf(
  file: FileInfo,
  result: FileResult | undefined,
  entry: FileRecord | undefined,
  options: { readonly separator: string; readonly timestamp: string },
): SuiteElement {
  const path = file.project === '' ? file.path : `${file.project} ${file.path}`
  const tests = [...(entry?.tests.values() ?? [])]
  const byTest = new Map<TaskId, { stream: string; text: string }[]>()
  const fileConsole: { stream: string; text: string }[] = []
  for (const event of entry?.console ?? []) {
    const own = event.taskId === null ? undefined : entry?.tests.get(event.taskId)
    if (own === undefined) {
      fileConsole.push(event)
      continue
    }
    const list = byTest.get(own.id)
    if (list === undefined) byTest.set(own.id, [event])
    else list.push(event)
  }

  let failures = 0
  let skipped = 0
  const cases: Element[] = tests.map((test) => {
    const taskResult = entry?.results.get(test.id)
    const late = entry?.late.get(test.id) ?? []
    const errors = [...(taskResult?.errors ?? []), ...late]
    const attributes = {
      name: test.fullName.join(options.separator),
      classname: file.path,
      time: seconds(taskResult?.durationMs ?? 0),
    }
    const children: Element[] = []
    if (taskResult === undefined) {
      skipped++
      children.push({ name: 'skipped', attributes: { message: 'not run' } })
    } else if (taskResult.state === 'fail' || late.length > 0) {
      failures++
      children.push(problem('failure', errors))
    } else if (taskResult.state === 'skip' || taskResult.state === 'todo') {
      skipped++
      children.push({
        name: 'skipped',
        attributes: {
          message:
            taskResult.state === 'todo' ? 'todo' : (taskResult.note ?? taskResult.skipReason),
        },
      })
    }
    children.push(...consoleElements(byTest.get(test.id) ?? []))
    return { name: 'testcase', attributes, children }
  })

  // The file's own errors: it never collected, its worker died, a suite's `afterAll` threw.
  const own = [
    ...(result?.errors ?? []),
    ...(entry?.suiteErrors ?? []),
    ...(entry?.unhandled ?? []),
  ]
  let errored = 0
  if (own.length > 0) {
    errored = 1
    cases.push({
      name: 'testcase',
      attributes: {
        name: tests.length === 0 ? 'Test suite failed to run' : 'Errors outside the tests',
        classname: file.path,
        time: '0.000',
      },
      children: [problem('error', own)],
    })
  }

  const count = cases.length
  const children: Element[] = [...cases, ...consoleElements(fileConsole)]
  return {
    element: {
      name: 'testsuite',
      attributes: {
        name: path,
        tests: count,
        failures,
        errors: errored,
        skipped,
        time: seconds(result?.durationMs ?? 0),
        timestamp: options.timestamp,
        file: file.path,
      },
      children,
    },
    tests: count,
    failures,
    errors: errored,
    skipped,
  }
}

/** A suite for the errors that belong to no file, one `<testcase>` each. */
function runErrorSuite(record: RunRecord, timestamp: string): SuiteElement | undefined {
  if (record.runErrors.length === 0) return undefined
  const cases = record.runErrors.map(
    ({ error }): Element => ({
      name: 'testcase',
      attributes: { name: firstLine(error.message) || error.name, classname: 'run', time: '0.000' },
      children: [problem('error', [error])],
    }),
  )
  return {
    element: {
      name: 'testsuite',
      attributes: {
        name: 'Errors outside any test file',
        tests: cases.length,
        failures: 0,
        errors: cases.length,
        skipped: 0,
        time: '0.000',
        timestamp,
      },
      children: cases,
    },
    tests: cases.length,
    failures: 0,
    errors: cases.length,
    skipped: 0,
  }
}

/**
 * The JUnit reporter: one XML document at `run:end`, in the schema Jenkins and most CI systems
 * read (the Jenkins xunit plugin's `junit-10.xsd`, which the reporter's tests validate against
 * with `xmllint`). A file is a `<testsuite>` and a test a `<testcase>`: its `classname` is the
 * file's path, its `name` the `describe` titles and its own joined with the dialect's separator.
 * A failed test has a `<failure>`; a skipped or todo test a `<skipped>`; a file that failed to run,
 * or whose worker died, an `<error>` on a testcase of its own; an error outside any file is a
 * suite of its own. A test's console output is its `<system-out>` and `<system-err>`.
 * @public
 */
export function junitReporter(options: JUnitReporterOptions): Reporter {
  const now = options.now ?? Date.now
  const { record, handlers } = createCollector()
  let timestamp = new Date(now()).toISOString()

  return {
    name: 'junit',

    ...handlers,

    'run:start'(info, files) {
      handlers['run:start'](info, files)
      timestamp = new Date(now()).toISOString()
    },

    async 'run:end'(summary: RunSummary) {
      const suites: SuiteElement[] = summary.files.map((result) =>
        suiteOf(result.file, result, record.files.get(result.file.fileId), {
          separator: options.report.displaySeparator,
          timestamp,
        }),
      )
      const runErrors = runErrorSuite(record, timestamp)
      if (runErrors !== undefined) suites.push(runErrors)
      const sum = (pick: (suite: SuiteElement) => number): number =>
        suites.reduce((total, suite) => total + pick(suite), 0)
      const document: Element = {
        name: 'testsuites',
        attributes: {
          name: options.name ?? 'provino',
          tests: sum((suite) => suite.tests),
          failures: sum((suite) => suite.failures),
          errors: sum((suite) => suite.errors),
          time: seconds(summary.durationMs),
        },
        children: suites.map((suite) => suite.element),
      }
      const text = `<?xml version="1.0" encoding="UTF-8"?>\n${write(document)}\n`
      if (options.outputFile !== undefined) {
        await writeAtomically(resolve(options.outputFile), text)
      } else {
        await (options.stream ?? process.stdout).write(text)
      }
    },
  }
}
