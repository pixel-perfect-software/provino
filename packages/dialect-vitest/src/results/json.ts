// T11.16: Vitest 5.0.5's `json` reporter output (`packages/vitest/src/node/reporters/json.ts`,
// `JsonReporter.onTestRunEnd` L105-L230), built from the run's events as a neutral reporter
// (D103's pattern: the Jest dialect's `createJestResults`). Register it before the reporter that
// writes the document, so the run is folded by the time `run:end` is heard.
import { join } from 'node:path'
import type {
  FileInfo,
  FileResult,
  Reporter,
  RunSummary,
  SerializedError,
  SuiteTask,
  TaskId,
  TaskNode,
  TaskResult,
  TestTask,
} from '@provino/types'

/**
 * A test's status in Vitest's JSON (`StatusMap`, L22-L30).
 * @public
 */
export type VitestJsonStatus = 'passed' | 'failed' | 'skipped' | 'pending' | 'todo' | 'disabled'

/**
 * One test (`JsonAssertionResult`, L32-L43).
 * @public
 */
export interface VitestJsonAssertionResult {
  readonly ancestorTitles: readonly string[]
  readonly fullName: string
  readonly status: VitestJsonStatus
  readonly title: string
  readonly duration?: number | undefined
  readonly failureMessages: readonly string[]
  readonly location?: { readonly line: number; readonly column: number } | undefined
  readonly meta: Readonly<Record<string, unknown>>
  readonly tags: readonly string[]
}

/**
 * One file (`JsonTestResult`, L45-L54).
 * @public
 */
export interface VitestJsonTestResult {
  readonly assertionResults: readonly VitestJsonAssertionResult[]
  readonly startTime: number
  readonly endTime: number
  readonly status: 'failed' | 'passed'
  readonly message: string
  readonly name: string
}

/**
 * `@vitest/snapshot`'s `SnapshotSummary` (`manager.ts` `emptySummary`, key order kept).
 * @public
 */
export interface VitestSnapshotSummary {
  readonly added: number
  readonly failure: boolean
  readonly filesAdded: number
  readonly filesRemoved: number
  readonly filesRemovedList: readonly string[]
  readonly filesUnmatched: number
  readonly filesUpdated: number
  readonly matched: number
  readonly total: number
  readonly unchecked: number
  readonly uncheckedKeysByFile: readonly {
    readonly filePath: string
    readonly keys: readonly string[]
  }[]
  readonly unmatched: number
  readonly updated: number
  readonly didUpdate: boolean
}

/**
 * The whole document (`JsonTestResults`, L56-L72), in the order `onTestRunEnd` builds it.
 * @public
 */
export interface VitestJsonResults {
  readonly numTotalTestSuites: number
  readonly numPassedTestSuites: number
  readonly numFailedTestSuites: number
  readonly numPendingTestSuites: number
  readonly numTotalTests: number
  readonly numPassedTests: number
  readonly numFailedTests: number
  readonly numPendingTests: number
  readonly numTodoTests: number
  readonly snapshot: VitestSnapshotSummary
  readonly startTime: number
  readonly success: boolean
  readonly testResults: readonly VitestJsonTestResult[]
}

/**
 * What the collector needs of the run.
 * @public
 */
export interface VitestResultsOptions {
  /** Each project's root, by the project's place among the run's projects; a file's `name` is its path under it. */
  readonly roots: readonly string[]
  /** `passWithNoTests`: a run with no file still succeeds. */
  readonly passWithNoTests: boolean
  /** `includeTaskLocation`: each test's `location`. */
  readonly includeTaskLocation: boolean
  /** The wall clock; default `Date.now`. */
  readonly now?: () => number
}

/**
 * The collector: `reporter` goes on the bus, `json()` gives the document once the run has ended.
 * @public
 */
export interface VitestResults {
  readonly reporter: Reporter
  json(): VitestJsonResults
}

interface FileState {
  readonly info: FileInfo
  nodes: Map<TaskId, TaskNode>
  order: TaskId[]
  readonly results: Map<TaskId, TaskResult>
  readonly started: Map<TaskId, number>
  result: FileResult | undefined
}

const STATUS: Readonly<Record<string, VitestJsonStatus>> = {
  fail: 'failed',
  only: 'pending',
  pass: 'passed',
  run: 'pending',
  running: 'pending',
  skip: 'skipped',
  todo: 'todo',
  queued: 'pending',
}

/** A failure as Vitest's JSON has it: `e.stack || e.message` (L170). */
const failureOf = (error: SerializedError): string => error.stack || error.message

/**
 * Folds a run's events into Vitest's JSON results.
 * @public
 */
export function createVitestResults(options: VitestResultsOptions): VitestResults {
  const now = options.now ?? Date.now
  let start = now()
  const files = new Map<TaskId, FileState>()
  let summary: RunSummary | undefined

  const stateOf = (info: FileInfo): FileState => {
    let file = files.get(info.fileId)
    if (file === undefined) {
      file = {
        info,
        nodes: new Map(),
        order: [],
        results: new Map(),
        started: new Map(),
        result: undefined,
      }
      files.set(info.fileId, file)
    }
    return file
  }

  const reporter: Reporter = {
    name: 'vitest-results',
    'run:start': () => {
      start = now()
      files.clear()
      summary = undefined
    },
    'file:start': (info) => {
      stateOf(info)
    },
    'file:collected': (info, event) => {
      const file = stateOf(info)
      file.nodes = new Map(event.tasks.map((task) => [task.id, task]))
      file.order = event.tasks.map((task) => task.id)
    },
    'task:start': (task) => {
      files.get(task.fileId)?.started.set(task.id, now())
    },
    'task:end': (task, event) => {
      files.get(task.fileId)?.results.set(task.id, event.result)
    },
    'file:end': (result) => {
      stateOf(result.file).result = result
    },
    'run:end': (run) => {
      summary = run
    },
  }

  const json = (): VitestJsonResults => {
    const ordered = [...files.values()]
    const suitesOf = (file: FileState): SuiteTask[] =>
      file.order.flatMap((id) => {
        const node = file.nodes.get(id)
        return node?.type === 'suite' ? [node] : []
      })
    const testsOf = (file: FileState): TestTask[] =>
      file.order.flatMap((id) => {
        const node = file.nodes.get(id)
        return node?.type === 'test' ? [node] : []
      })
    const fileFailed = (file: FileState): boolean => file.result?.state === 'fail'
    // `getSuites(files)` holds the files too (a Vitest `File` is a suite).
    let numTotalTestSuites = 0
    let numFailedTestSuites = 0
    let numPendingTestSuites = 0
    let numTotalTests = 0
    let numFailedTests = 0
    let numPassedTests = 0
    let numPendingTests = 0
    let numTodoTests = 0
    const testResults: VitestJsonTestResult[] = []
    for (const file of ordered) {
      numTotalTestSuites++
      if (fileFailed(file)) numFailedTestSuites++
      for (const suite of suitesOf(file)) {
        numTotalTestSuites++
        const state = file.results.get(suite.id)?.state
        if (state === 'fail') numFailedTestSuites++
        else if (state === 'running' || state === 'queued' || suite.mode === 'todo')
          numPendingTestSuites++
      }
      const tests = testsOf(file)
      let startTime = Number.POSITIVE_INFINITY
      for (const test of tests)
        startTime = Math.min(startTime, file.started.get(test.id) ?? Number.POSITIVE_INFINITY)
      if (startTime === Number.POSITIVE_INFINITY) startTime = start
      let endTime = startTime
      const assertionResults = tests.map((test): VitestJsonAssertionResult => {
        const result = file.results.get(test.id)
        const state = result?.state
        numTotalTests++
        if (state === 'fail') numFailedTests++
        if (state === 'pass') numPassedTests++
        if (state === 'running' || state === 'queued' || test.mode === 'skip' || state === 'skip')
          numPendingTests++
        if (test.mode === 'todo') numTodoTests++
        endTime = Math.max(endTime, (file.started.get(test.id) ?? 0) + (result?.durationMs ?? 0))
        const ancestorTitles = test.fullName.slice(0, -1)
        return {
          ancestorTitles,
          fullName: test.name ? [...ancestorTitles, test.name].join(' ') : ancestorTitles.join(' '),
          status: STATUS[state ?? test.mode] ?? 'skipped',
          title: test.name,
          duration: result?.durationMs,
          failureMessages: (result?.errors ?? []).map(failureOf),
          location:
            options.includeTaskLocation && test.location !== null
              ? { line: test.location.line, column: test.location.column }
              : undefined,
          meta: test.meta,
          tags: test.tags,
        }
      })
      const hasFailedTests = tests.some((test) => file.results.get(test.id)?.state === 'fail')
      const root = options.roots[file.info.projectIndex ?? 0] ?? options.roots[0] ?? ''
      testResults.push({
        assertionResults,
        startTime,
        endTime,
        status: fileFailed(file) || hasFailedTests ? 'failed' : 'passed',
        message: file.result?.errors[0]?.message ?? '',
        name: join(root, file.info.path),
      })
    }
    const numPassedTestSuites = numTotalTestSuites - numFailedTestSuites - numPendingTestSuites
    return {
      numTotalTestSuites,
      numPassedTestSuites,
      numFailedTestSuites,
      numPendingTestSuites,
      numTotalTests,
      numPassedTests,
      numFailedTests,
      numPendingTests,
      numTodoTests,
      snapshot: snapshotSummary(summary),
      startTime: start,
      success:
        (ordered.length > 0 || options.passWithNoTests) &&
        numFailedTestSuites === 0 &&
        numFailedTests === 0,
      testResults,
    }
  }

  return { reporter, json }
}

/** The run's snapshot counters as `@vitest/snapshot`'s `SnapshotSummary`. */
function snapshotSummary(run: RunSummary | undefined): VitestSnapshotSummary {
  const snapshots = run?.snapshots
  const c = snapshots?.counters
  return {
    added: c?.added ?? 0,
    // unverified: track-07 (Vitest's core sets `failure` from the run; no fixture records it yet)
    failure: false,
    filesAdded: c?.filesAdded ?? 0,
    filesRemoved: c?.filesRemoved ?? 0,
    filesRemovedList: [...(snapshots?.filesRemovedList ?? [])],
    filesUnmatched: c?.filesUnmatched ?? 0,
    filesUpdated: c?.filesUpdated ?? 0,
    matched: c?.matched ?? 0,
    total: c?.total ?? 0,
    unchecked: c?.unchecked ?? 0,
    uncheckedKeysByFile: (snapshots?.uncheckedKeysByFile ?? []).map((entry) => ({
      filePath: entry.file,
      keys: entry.keys,
    })),
    unmatched: c?.unmatched ?? 0,
    updated: c?.updated ?? 0,
    didUpdate: snapshots?.update === 'all',
  }
}
