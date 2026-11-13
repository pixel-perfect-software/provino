import type {
  FileInfo,
  FileResult,
  Reporter,
  ReportPolicy,
  RunSummary,
  SerializedError,
  TaskId,
  TaskNode,
  TaskResult,
  TaskState,
} from '@provino/types'
import type { TextSink } from '../sink.ts'
import { createStyle } from '../style.ts'
import { type ConsoleEntry, consoleBlock, consoleEntries } from './console.ts'
import {
  displayPath,
  type ErrorFormat,
  failLine,
  failureBlock,
  obsoleteBlock,
  openHandlesText,
  passLine,
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
  /** The `report` slice: the title separator and the failure bullet. */
  readonly report: ReportPolicy
  /** ANSI colours. Default `false`. */
  readonly colour?: boolean
  /**
   * Keep a block of the running files at the bottom of the output, redrawn as files start and
   * finish (a terminal, not CI, not an agent). Default `false`.
   */
  readonly live?: boolean
  /** The terminal's width, for the live block. Default 80. */
  readonly columns?: number
  /** Print none of the tests' console output (Jest's `--silent`). */
  readonly silent?: boolean
  /** Leave the stack frames out of the failure messages (Jest's `--noStackTrace`). */
  readonly noStackTrace?: boolean
  /** `verbose`: list skipped and todo tests in declaration order, not after the others (Jest's `--expand`). */
  readonly expand?: boolean
}

/**
 * Options for `defaultReporter`.
 * @public
 */
export type DefaultReporterOptions = TextReporterOptions

/** What a text reporter prints about each file. */
export type TextMode = 'default' | 'verbose' | 'agent' | 'dot'

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
export function createTextReporter(
  mode: TextMode,
  options: TextReporterOptions,
  name: string = mode,
): Reporter {
  const { stream, report } = options
  const style = createStyle(options.colour === true)
  const errorFormat: ErrorFormat = { stackTrace: options.noStackTrace !== true }
  const out = createLiveOutput(stream, {
    live: options.live === true && mode !== 'agent',
    columns: options.columns ?? 80,
    style,
  })
  const quiet = mode === 'agent' || mode === 'dot'
  const columns = options.columns ?? 80
  let state = freshState()
  // Whether the last thing printed ended in a blank line, so the totals don't add a second.
  let atBlank = true
  // `dot`: the characters on the current line, and the failed files, printed after the dots.
  let dots = 0
  let deferred: string[] = []

  async function writeDot(testState: TaskState): Promise<void> {
    const mark =
      testState === 'pass'
        ? style.green('.')
        : testState === 'fail'
          ? style.red('F')
          : style.yellow('-')
    dots++
    await stream.write(dots % columns === 0 ? `${mark}\n` : mark)
  }

  async function print(text: string): Promise<void> {
    atBlank = text.endsWith('\n')
    await out.print(text)
  }

  const labelOf = (file: FileInfo): string =>
    file.project === '' ? displayPath(file.path) : `${file.project} ${displayPath(file.path)}`

  /** Jest marks a suite skipped only when every test is skipped: a file with a todo test passed. */
  function effectiveState(result: FileResult): FileResult['state'] {
    if (result.state !== 'skip') return result.state
    const todo = (state.collected.get(result.file.fileId) ?? []).some(
      (task) => state.results.get(task.id)?.state === 'todo',
    )
    return todo ? 'pass' : 'skip'
  }

  return {
    name,

    'run:start'(_info, files) {
      state = freshState()
      state.queued = files.length
      dots = 0
      deferred = []
    },

    async 'file:start'(file) {
      await out.start(file.fileId, labelOf(file))
    },

    // Kept until the file ends: a suite's name path is only built if that suite failed.
    'file:collected'(file, event) {
      state.collected.set(file.fileId, event.tasks)
    },

    async 'task:end'(task, event) {
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
      state.results.set(task.id, event.result)
      if (mode === 'dot' && testState !== 'queued' && testState !== 'running') {
        await writeDot(testState)
      }
      if (testState !== 'fail') return
      push(state.failures, task.fileId, { title: testTitle(report, task.fullName), errors })
    },

    console(file, event) {
      if (options.silent === true || quiet) return
      push(state.console, file.fileId, {
        stream: event.stream,
        level: event.level,
        text: event.text,
        origin: event.origin,
      })
    },

    async 'file:end'(result) {
      const { fileId } = result.file
      const effective = effectiveState(result)
      state.files = tally(state.files, effective)
      const failed = state.failures.get(fileId) ?? []
      const failedSuites = state.suiteFailures.get(fileId) ?? []
      const tasks = state.collected.get(fileId) ?? []
      const text = fileText(result, effective, failed, failedSuites, tasks)
      state.failures.delete(fileId)
      state.suiteFailures.delete(fileId)
      state.console.delete(fileId)
      for (const task of tasks) state.results.delete(task.id)
      state.collected.delete(fileId)
      await out.finish(fileId)
      if (text === undefined) return
      if (mode === 'dot') deferred.push(text)
      else await print(text)
    },

    // An error charged to a test after it ended fails that test (and so its file): shown with it.
    unhandled(file, event) {
      if (file === null || event.ownerId === null) return
      const test = state.collected
        .get(file.fileId)
        ?.find((task) => task.id === event.ownerId && task.type === 'test')
      if (test === undefined || test.type !== 'test') return
      const title = testTitle(report, test.fullName)
      const ended = state.results.get(test.id)
      const listed = state.failures.get(file.fileId)?.findIndex((entry) => entry.title === title)
      if (ended?.state === 'fail' && listed !== undefined && listed >= 0) {
        // It already failed: the late error joins its entry, and the counts stand.
        const entry = state.failures.get(file.fileId)?.[listed]
        if (entry !== undefined) {
          state.failures.get(file.fileId)?.splice(listed, 1, {
            title,
            errors: [...entry.errors, event.error],
          })
        }
        return
      }
      // Only a test that passed moves from the passed count to the failed one.
      if (ended?.state !== 'pass') return
      push(state.failures, file.fileId, { title, errors: [event.error] })
      state.results.set(test.id, { ...ended, state: 'fail' })
      const { passed, failed } = state.tests
      state.tests = { ...state.tests, failed: failed + 1, passed: Math.max(0, passed - 1) }
    },

    async error(error, origin) {
      await print(failureBlock(report, ERROR_LABELS[origin], [error], style, errorFormat))
    },

    async 'run:end'(summary: RunSummary) {
      await out.close()
      if (mode === 'dot') {
        // The dots end the line they are on; the failed files follow, a blank line apart.
        if (dots % columns !== 0) await stream.write('\n')
        if (deferred.length > 0) await print(['', ...deferred].join('\n'))
        // Text follows the dots, so the totals' blank line goes between them.
        else if (dots > 0) atBlank = false
      }
      const unhandled = summary.unhandled.map((error) =>
        failureBlock(report, 'Unhandled error', [error], style, errorFormat),
      )
      const obsolete = obsoleteBlock(summary.snapshots)
      const parts = [
        ...unhandled,
        ...(obsolete === '' ? [] : [obsolete]),
        summaryLines(
          state.files,
          state.tests,
          summary.durationMs,
          snapshotLine(summary.snapshots, style),
          state.queued,
          style,
        ),
      ]
      await print((atBlank ? parts : ['', ...parts]).join('\n'))
      if (summary.openHandles !== undefined) await print(openHandlesText(summary.openHandles))
    },
  }

  /** What a file prints, or `undefined` for none (a skipped file; a passing one under `agent`). */
  function fileText(
    result: FileResult,
    effective: FileResult['state'],
    failed: readonly FailedTest[],
    failedSuites: readonly FailedTest[],
    tasks: readonly TaskNode[],
  ): string | undefined {
    if (effective === 'skip') return undefined
    if (quiet && effective === 'pass') return undefined
    const shown = labelOf(result.file)
    const header =
      effective === 'pass'
        ? passLine(shown, result.durationMs, style)
        : failLine(shown, result.durationMs, style)
    const entries = state.console.get(result.file.fileId) ?? []
    const parts: string[] = []
    if (mode === 'verbose') {
      if (entries.length > 0) {
        parts.push(
          consoleEntries(
            entries,
            { titleIndent: 2, stackTrace: errorFormat.stackTrace !== false },
            style,
          ),
        )
      }
      parts.push(header)
      parts.push(...verboseList(tasks, state.results, style, { expand: options.expand === true }))
    } else {
      parts.push(header)
      if (entries.length > 0 && mode === 'default') {
        parts.push(consoleBlock(entries, style, errorFormat.stackTrace !== false))
      }
    }
    if (effective === 'fail') {
      const blocks = [...failed, ...failedSuites].map((test) =>
        failureBlock(report, test.title, test.errors, style, errorFormat),
      )
      if (result.errors.length > 0) {
        const title =
          failed.length + failedSuites.length === 0
            ? 'Test suite failed to run'
            : 'Errors outside the tests'
        blocks.push(failureBlock(report, title, result.errors, style, errorFormat))
      }
      parts.push(...blocks)
    }
    return parts.join('\n')
  }
}

/** Everything one run accumulates; `run:start` replaces it whole. */
interface RunState {
  failures: Map<TaskId, FailedTest[]>
  /** Suites that ended `fail` with errors of their own, kept like failed tests. */
  suiteFailures: Map<TaskId, FailedTest[]>
  /** Each file's collected tasks, from `file:collected` until its `file:end`. */
  collected: Map<TaskId, readonly TaskNode[]>
  /** How each test ended, from its `task:end` until its file ends (a late error and the list read it). */
  results: Map<TaskId, TaskResult>
  /** Each file's console output, from the first write until its `file:end`. */
  console: Map<TaskId, ConsoleEntry[]>
  /** File tallies (`todo` stays 0) and test tallies. */
  files: TestCounts
  tests: TestCounts
  /** How many files `run:start` announced; more than `files.total` when the run ended early (bail). */
  queued: number
}

function freshState(): RunState {
  return {
    queued: 0,
    failures: new Map(),
    suiteFailures: new Map(),
    collected: new Map(),
    results: new Map(),
    console: new Map(),
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
