import type {
  FileInfo,
  FileResult,
  Reporter,
  ReportPolicy,
  RunSummary,
  SerializedError,
  TaskId,
} from '@provino/types'
import {
  createCollector,
  type FileRecord,
  groupConsole,
  outcomeOf,
  type RunRecord,
  suiteErrorsOf,
} from '../internal/collect.ts'
import { writeDocument } from '../internal/write-file.ts'
import type { TextSink } from '../sink.ts'
import { formatErrors, projectLabel, seconds, testTitle } from '../text/format.ts'
import { type Element, write, writeParent } from './xml.ts'

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
    text: formatErrors(errors),
  }
}

const NO_ELEMENTS: readonly Element[] = []

/** Console writes as `system-out` and `system-err` elements: each stream's text in order. */
function consoleElements(entries: readonly { stream: string; text: string }[]): readonly Element[] {
  if (entries.length === 0) return NO_ELEMENTS
  const out = entries.filter((entry) => entry.stream === 'stdout').map((entry) => entry.text)
  const err = entries.filter((entry) => entry.stream === 'stderr').map((entry) => entry.text)
  return [
    ...(out.length === 0 ? [] : [{ name: 'system-out', text: out.join('') }]),
    ...(err.length === 0 ? [] : [{ name: 'system-err', text: err.join('') }]),
  ]
}

/** What a `<testsuite>` adds up to in `<testsuites>`. */
interface Counts {
  readonly tests: number
  readonly failures: number
  readonly errors: number
}

/** A `<testsuite>` and the counts the document sums. */
interface SuiteElement {
  readonly element: Element
  readonly counts: Counts
}

/** A `<testsuite>` already written as XML, with its counts. */
interface WrittenSuite {
  readonly text: string
  readonly counts: Counts
}

/** The file's `<testsuite>`, from what the run recorded of it. */
function suiteOf(
  file: FileInfo,
  result: FileResult | undefined,
  entry: FileRecord | undefined,
  options: { readonly report: ReportPolicy; readonly timestamp: string },
): SuiteElement {
  const tests = entry === undefined ? [] : [...entry.tests.values()]
  const grouped = entry === undefined ? undefined : groupConsole(entry)

  let failures = 0
  let skipped = 0
  const cases: Element[] = tests.map((test) => {
    // The outcome (and its errors) is only built for a test that did not simply pass.
    const ended = entry?.results.get(test.id)
    const passed = ended?.state === 'pass' && entry?.late.has(test.id) !== true
    const outcome = passed || entry === undefined ? undefined : outcomeOf(entry, test)
    const result = passed ? ended : outcome?.result
    const attributes = {
      name: testTitle(options.report, test.fullName),
      classname: file.path,
      time: seconds(result?.durationMs ?? 0),
    }
    const children: Element[] = []
    if (passed) {
      // Nothing to say but its console output.
    } else if (outcome?.failed === true) {
      failures++
      children.push(problem('failure', outcome.errors))
    } else if (result === undefined) {
      skipped++
      children.push({ name: 'skipped', attributes: { message: 'not run' } })
    } else if (result.state === 'skip' || result.state === 'todo') {
      skipped++
      children.push({
        name: 'skipped',
        attributes: {
          message: result.state === 'todo' ? 'todo' : (result.note ?? result.skipReason),
        },
      })
    }
    children.push(...consoleElements(grouped?.tests.get(test.id) ?? []))
    return { name: 'testcase', attributes, children }
  })

  // The file's own errors: it never collected, its worker died, a suite's `afterAll` threw.
  const own = [
    ...(result?.errors ?? []),
    ...(entry === undefined ? [] : suiteErrorsOf(entry)),
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

  const counts = { tests: cases.length, failures, errors: errored }
  return {
    element: {
      name: 'testsuite',
      attributes: {
        name: projectLabel(file, file.path),
        ...counts,
        skipped,
        time: seconds(result?.durationMs ?? 0),
        timestamp: options.timestamp,
        file: file.path,
      },
      children: [...cases, ...consoleElements(grouped?.file ?? [])],
    },
    counts,
  }
}

/** A suite for the errors that belong to no file, one `<testcase>` each. */
function runErrorSuite(record: RunRecord): SuiteElement | undefined {
  if (record.runErrors.length === 0) return undefined
  const cases = record.runErrors.map(
    ({ error }): Element => ({
      name: 'testcase',
      attributes: { name: firstLine(error.message) || error.name, classname: 'run', time: '0.000' },
      children: [problem('error', [error])],
    }),
  )
  const counts = { tests: cases.length, failures: 0, errors: cases.length }
  return {
    element: {
      name: 'testsuite',
      attributes: {
        name: 'Errors outside any test file',
        ...counts,
        skipped: 0,
        time: '0.000',
        timestamp: record.startedAt,
      },
      children: cases,
    },
    counts,
  }
}

/**
 * The JUnit reporter: one XML document at `run:end`, in the schema Jenkins and most CI systems
 * read (the Jenkins xunit plugin's `junit-10.xsd`, which the reporter's tests validate against
 * with libxml2). A file is a `<testsuite>` and a test a `<testcase>`: its `classname` is the
 * file's path, its `name` the `describe` titles and its own joined with the dialect's separator.
 * A failed test has a `<failure>`; a skipped or todo test a `<skipped>`; a file that failed to run,
 * or whose worker died, an `<error>` on a testcase of its own; an error outside any file is a
 * suite of its own. A test's console output is its `<system-out>` and `<system-err>`.
 * @public
 */
export function junitReporter(options: JUnitReporterOptions): Reporter {
  const { record, handlers, release, isReleased } = createCollector(
    options.now === undefined ? {} : { now: options.now },
  )
  /** Each file's `<testsuite>` as XML, written when the file ended, so its record could go. */
  const written = new Map<TaskId, WrittenSuite>()
  const { report } = options

  /** The suite as XML, one level down (a child of `<testsuites>`). */
  const writeSuite = (suite: SuiteElement): WrittenSuite => ({
    text: write(suite.element, 1),
    counts: suite.counts,
  })

  return {
    name: 'junit',

    ...handlers,

    'run:start'(info, files) {
      handlers['run:start'](info, files)
      written.clear()
    },

    // The file is over (an event for it after this is dropped): say it once, and free its record.
    'file:end'(result) {
      handlers['file:end'](result)
      const { fileId } = result.file
      const suite = suiteOf(result.file, result, record.files.get(fileId), {
        report,
        timestamp: record.startedAt,
      })
      written.set(fileId, writeSuite(suite))
      release(fileId)
    },

    // An error charged to a file that has ended can't join its suite: it is one of the run's.
    unhandled(file, event) {
      if (file !== null && isReleased(file.fileId)) {
        record.runErrors.push({ error: event.error, unhandled: true })
        return
      }
      handlers.unhandled(file, event)
    },

    async 'run:end'(summary: RunSummary) {
      const suites: WrittenSuite[] = summary.files.map(
        (result) =>
          written.get(result.file.fileId) ??
          writeSuite(
            suiteOf(result.file, result, record.files.get(result.file.fileId), {
              report,
              timestamp: record.startedAt,
            }),
          ),
      )
      const runErrors = runErrorSuite(record)
      if (runErrors !== undefined) suites.push(writeSuite(runErrors))
      const sum = (pick: (counts: Counts) => number): number =>
        suites.reduce((total, suite) => total + pick(suite.counts), 0)
      const document = writeParent(
        {
          name: 'testsuites',
          attributes: {
            name: options.name ?? 'provino',
            tests: sum((counts) => counts.tests),
            failures: sum((counts) => counts.failures),
            errors: sum((counts) => counts.errors),
            time: seconds(summary.durationMs),
          },
        },
        suites.map((suite) => suite.text),
      )
      await writeDocument(options, `<?xml version="1.0" encoding="UTF-8"?>\n${document}\n`)
    },
  }
}
