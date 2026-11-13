import type {
  FileResult,
  Reporter,
  ReportPolicy,
  RunSummary,
  SerializedError,
  TaskNode,
  TaskState,
} from '@provino/types'
import { DEFAULT_COLUMNS } from '../environment.ts'
import { createCollector, type FileRecord, outcomeOf } from '../internal/collect.ts'
import type { TextSink } from '../sink.ts'
import { createStyle } from '../style.ts'
import { consoleBlock, consoleEntries } from './console.ts'
import { createDots } from './dots.ts'
import {
  displayPath,
  failLine,
  failureBlock,
  obsoleteBlock,
  openHandlesText,
  passLine,
  projectLabel,
  snapshotLine,
  summaryLines,
  type TestCounts,
  testTitle,
} from './format.ts'
import { createLiveOutput } from './live.ts'
import { verboseList } from './verbose.ts'

/**
 * Options for the text reporters (`default`, `verbose`, `agent`).
 * @public
 */
export interface TextReporterOptions {
  readonly stream: TextSink
  /**
   * The `report` slice: the title separator, the failure bullet, and whether `default` lists every
   * test in a run of exactly one test file (`listTestsForSingleFile`, which `silent` and
   * `verbose: false` turn off, as Jest's `runJest` has it).
   */
  readonly report: ReportPolicy
  /** ANSI colours. Default `false`. */
  readonly colour?: boolean
  /**
   * Keep a block of the running files at the bottom of the output, redrawn as files start and
   * finish (a terminal, not CI, not an agent). Default `false`.
   */
  readonly live?: boolean
  /** The terminal's width in whole columns, for the live block and the dots' wrap, as `detectOutput` reports it. Default 80. */
  readonly columns?: number
  /** Print none of the tests' console output (Jest's `--silent`). */
  readonly silent?: boolean
  /** Leave the stack frames out of the failure messages (Jest's `--noStackTrace`). */
  readonly noStackTrace?: boolean
  /** `verbose`: list skipped and todo tests in declaration order, not after the others (Jest's `--expand`). */
  readonly expand?: boolean
  /**
   * Jest's `verbose: false`, set on purpose (a `verbose` that is unset is not `false`): it turns
   * off the policy's `listTestsForSingleFile`. `verbose` itself is the `verbose` reporter's.
   */
  readonly verbose?: false
}

/**
 * Options for `defaultReporter`.
 * @public
 */
export type DefaultReporterOptions = TextReporterOptions

/** What a text reporter prints about each file. */
export type TextMode = 'default' | 'verbose' | 'agent' | 'dot'

/** What a mode does, so the engine asks a trait and never the mode's name. */
interface Traits {
  /** A passing file prints nothing: only the failures, and the totals. */
  readonly quiet: boolean
  /** The running files may be a block that is redrawn (the dots' row is not something a redraw can leave alone). */
  readonly live: boolean
  /** A file's console output is printed. */
  readonly console: boolean
  /** Whether each file's tests are listed: always, in a run of one file when the policy says so, or never. */
  readonly list: 'always' | 'single-file' | 'never'
  /** One character per test as it ends, and the failed files after them. */
  readonly dots: boolean
}

const TRAITS: Readonly<Record<TextMode, Traits>> = {
  default: { quiet: false, live: true, console: true, list: 'single-file', dots: false },
  verbose: { quiet: false, live: true, console: true, list: 'always', dots: false },
  agent: { quiet: true, live: false, console: false, list: 'never', dots: false },
  dot: { quiet: true, live: false, console: false, list: 'never', dots: true },
}

/** How an `error` event is labelled, by where it came from. */
const ERROR_LABELS = {
  coordinator: 'Run error',
  reporter: 'Reporter error',
  globalSetup: 'Global setup error',
} as const

/** A test, or a suite with errors of its own, that failed. */
interface Failure {
  readonly title: string
  readonly errors: readonly SerializedError[]
}

/**
 * The text reporters: Jest-like text per file, then the totals. They keep their tallies in the
 * closure, so one reporter serves one run at a time and starts over at each `run:start`.
 *
 * - `default`: a `PASS` or `FAIL` line per file (none for a file whose every test is skipped), the
 *   file's console output under it, and for a failure each failed test's title with its errors.
 * - `verbose`: as `default`, with the file's tests listed under it, and the console output before
 *   the header, as Jest prints it live.
 * - `agent`: only the files that failed, and no console output: the failures and the totals.
 * - `dot`: one character per test as it ends (`.` passed, `F` failed, `-` skipped or todo), wrapped
 *   at the terminal's width; at the end the failed files, as `agent` prints them, and the totals.
 */
export function createTextReporter(mode: TextMode, options: TextReporterOptions): Reporter {
  const { stream, report } = options
  const traits = TRAITS[mode]
  const style = createStyle(options.colour === true)
  const stackTrace = options.noStackTrace !== true
  const columns = options.columns ?? DEFAULT_COLUMNS
  const out = createLiveOutput(stream, {
    live: options.live === true && traits.live,
    columns,
    style,
  })
  const dots = traits.dots ? createDots(stream, columns, style) : undefined
  // Each file's tests, results, console, tree and errors as its events come, until it ends.
  const { record, handlers, release } = createCollector({
    console: traits.console && options.silent !== true,
  })
  const { 'test:attempt-end': _attempts, ...collect } = handlers

  /** Whether each file's tests are listed (Jest's one-file rule, decided at `run:start` from the files it announces). */
  const lists = (files: number): boolean =>
    traits.list === 'always' ||
    (traits.list === 'single-file' &&
      report.listTestsForSingleFile &&
      options.silent !== true &&
      options.verbose !== false &&
      files === 1)
  let listing = lists(0)
  let files = zeroCounts()
  let tests = zeroCounts()
  /** How many files `run:start` announced; more than `files.total` when the run ended early (bail). */
  let queued = 0
  // Whether the last thing printed ended in a blank line, so the totals don't add a second.
  let atBlank = true

  async function print(text: string): Promise<void> {
    atBlank = text.endsWith('\n')
    await out.print(text)
  }

  /** The tests and suites of the file that failed, each with its errors, in the order they ended. */
  function failuresOf(entry: FileRecord | undefined): Failure[] {
    if (entry === undefined) return []
    const failed: Failure[] = []
    for (const [id, result] of entry.results) {
      // A late error fails its test, so a test that passed can be here.
      if (result.state !== 'fail' && !entry.late.has(id)) continue
      const test = entry.tests.get(id)
      if (test === undefined) continue
      const outcome = outcomeOf(entry, test)
      if (outcome.failed) {
        failed.push({ title: testTitle(report, test.fullName), errors: outcome.errors })
      }
    }
    for (const { task, errors } of entry.failedSuites) {
      const path = suitePath(entry.tasks, task) ?? [task.name]
      failed.push({ title: testTitle(report, path), errors })
    }
    return failed
  }

  /** What a file prints, or `undefined` for none (a skipped file; a passing one under `agent`). */
  function fileText(result: FileResult, entry: FileRecord | undefined): string | undefined {
    if (result.state === 'skip') return undefined
    if (traits.quiet && result.state === 'pass') return undefined
    const label = projectLabel(result.file, displayPath(result.file.path))
    const header =
      result.state === 'pass'
        ? passLine(label, result.durationMs, style)
        : failLine(label, result.durationMs, style)
    const entries = entry?.console ?? []
    const parts: string[] = []
    if (listing) {
      if (entries.length > 0) {
        parts.push(consoleEntries(entries, { titleIndent: 2, stackTrace }, style))
      }
      parts.push(header)
      if (entry !== undefined) {
        parts.push(
          ...verboseList(entry.tasks, (test) => outcomeOf(entry, test).result, style, {
            expand: options.expand === true,
          }),
        )
      }
    } else {
      parts.push(header)
      if (entries.length > 0) parts.push(consoleBlock(entries, style, stackTrace))
    }
    if (result.state === 'fail') {
      const failed = failuresOf(entry)
      parts.push(
        ...failed.map((test) => failureBlock(report, test.title, test.errors, style, stackTrace)),
      )
      if (result.errors.length > 0) {
        const title = failed.length === 0 ? 'Test suite failed to run' : 'Errors outside the tests'
        parts.push(failureBlock(report, title, result.errors, style, stackTrace))
      }
    }
    return parts.join('\n')
  }

  return {
    name: mode,

    ...collect,

    'run:start'(info, announced) {
      collect['run:start'](info, announced)
      files = zeroCounts()
      tests = zeroCounts()
      queued = announced.length
      listing = lists(announced.length)
      dots?.reset()
    },

    async 'file:start'(file) {
      await out.start(file.fileId, projectLabel(file, displayPath(file.path)))
    },

    async 'task:end'(task, event) {
      collect['task:end'](task, event)
      if (task.type !== 'test' || event.type !== 'test-end') return
      const { state } = event.result
      tests = tally(tests, state)
      if (dots !== undefined && state !== 'queued' && state !== 'running') await dots.mark(state)
    },

    // An error charged to a test after it ended fails that test (and so its file): shown with it.
    unhandled(file, event) {
      collect.unhandled(file, event)
      if (file === null || event.ownerId === null) return
      const entry = record.files.get(file.fileId)
      // Only the first late error moves the test between the counts: it is the failure itself.
      if (entry?.late.get(event.ownerId)?.length !== 1) return
      // Only a test that passed moves from the passed count to the failed one.
      if (entry.results.get(event.ownerId)?.state === 'pass') tests = passedToFailed(tests)
    },

    async 'file:end'(result) {
      const { fileId } = result.file
      files = tally(files, result.state)
      const text = fileText(result, record.files.get(fileId))
      release(fileId)
      await out.finish(fileId)
      if (text === undefined) return
      if (dots === undefined) await print(text)
      else dots.defer(text)
    },

    async error(error, origin) {
      const lead = (await dots?.leave()) ?? ''
      await print(lead + failureBlock(report, ERROR_LABELS[origin], [error], style, stackTrace))
    },

    async 'run:end'(summary: RunSummary) {
      await out.close()
      // `dot`: the dots end the row they are on; the failed files follow, a blank line apart.
      let lead = (await dots?.leave()) ?? ''
      const deferred = dots?.deferred() ?? ''
      if (deferred !== '') {
        await print(lead + deferred)
        lead = ''
      }
      const unhandled = summary.unhandled.map((error) =>
        failureBlock(report, 'Unhandled error', [error], style, stackTrace),
      )
      const obsolete = obsoleteBlock(summary.snapshots)
      const parts = [
        ...unhandled,
        ...(obsolete === '' ? [] : [obsolete]),
        summaryLines(
          files,
          tests,
          summary.durationMs,
          snapshotLine(summary.snapshots, style),
          queued,
          style,
        ),
      ]
      // A blank line apart from whatever came before, unless that already ended in one.
      await print(`${lead === '' && atBlank ? '' : '\n'}${parts.join('\n')}`)
      if (summary.openHandles !== undefined) await print(openHandlesText(summary.openHandles))
    },
  }
}

function zeroCounts(): TestCounts {
  return { failed: 0, skipped: 0, passed: 0, total: 0, todo: 0 }
}

/** The names from the root suite down to `suite`, or `undefined` when its file's tree is unknown. */
function suitePath(tasks: readonly TaskNode[], suite: TaskNode): readonly string[] | undefined {
  if (tasks.length === 0) return undefined
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

/** A test counted as passed failed after all: it moves to the failed count, and the total stands. */
function passedToFailed(counts: TestCounts): TestCounts {
  return { ...counts, failed: counts.failed + 1, passed: Math.max(0, counts.passed - 1) }
}
