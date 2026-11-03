// Per-test matcher state (T7.2, Track 7 R1). Jest keeps one global `MatcherState`, so
// `expect.assertions(n)` miscounts under `test.concurrent` (spike P4/P5). Here every test attempt
// gets its own state, found through the current-test lookup, so the global `expect` counts each
// test separately. Outside a test (suite hooks, a file's top level) the file's state is current,
// as Jest's one state would be.
import type { CurrentTest, MatcherState, TestTask } from '@provino/types'

/**
 * Options for `createStateSource`.
 * @public
 */
export interface StateSourceOptions {
  /** Joins a test's full name into `currentTestName`: the core policy's `nameSeparator`. */
  readonly nameSeparator: string
  /** Whether diffs show every line: `ExpectPolicy.expand` (Jest sets it once, from `--expand`). */
  readonly expand: boolean
}

/**
 * Where the engine finds the matcher state of the code that is running.
 * @public
 */
export interface StateSource {
  /** The running test attempt's state, or the file's when no test is running. */
  current(): MatcherState
  /** The file's state. */
  file(): MatcherState
  /**
   * Starts a file: a fresh file state with `testPath`, and the last file's test states dropped.
   */
  startFile(testPath: string | undefined): void
  /** The state of a test's latest attempt, if that attempt read or counted any. */
  stateOf(testId: string): MatcherState | undefined
}

interface Entry {
  readonly attempt: number
  readonly state: MatcherState
}

/**
 * Builds the state source from the worker's current-test lookup (core's `currentTest`). Typed by
 * `@provino/types`' `CurrentTest`, so the engine never imports core (Track 7 §Per-test state).
 * @public
 */
export function createStateSource(
  currentTest: CurrentTest,
  options: StateSourceOptions,
): StateSource {
  const { nameSeparator, expand } = options
  let fileState = newFileState(expand, undefined)
  let tests = new Map<string, Entry>()

  return {
    current(): MatcherState {
      const frame = currentTest.get()
      const test = frame?.test
      if (frame === undefined || test == null) return fileState
      const entry = tests.get(test.id)
      if (entry !== undefined && entry.attempt === frame.attempt) return entry.state
      const state = newAttemptState(fileState, test, nameSeparator)
      tests.set(test.id, { attempt: frame.attempt, state })
      return state
    },
    file(): MatcherState {
      return fileState
    },
    startFile(testPath: string | undefined): void {
      fileState = newFileState(expand, testPath)
      tests = new Map()
    },
    stateOf(testId: string): MatcherState | undefined {
      return tests.get(testId)?.state
    },
  }
}

function counters(): Pick<
  MatcherState,
  | 'assertionCalls'
  | 'expectedAssertionsNumber'
  | 'isExpectingAssertions'
  | 'numPassingAsserts'
  | 'suppressedErrors'
> {
  return {
    assertionCalls: 0,
    expectedAssertionsNumber: null,
    isExpectingAssertions: false,
    numPassingAsserts: 0,
    suppressedErrors: [],
  }
}

function newFileState(expand: boolean, testPath: string | undefined): MatcherState {
  return {
    ...counters(),
    expand,
    ...(testPath === undefined ? {} : { testPath }),
  }
}

/**
 * A new attempt starts from the file's state (so `expand`, `testPath` and keys a `beforeAll` set
 * carry over) with fresh counters and its own name. Keys a test sets with `expect.setState` stay
 * in that attempt: Jest's one shared object would carry them to the tests after it (B08 notes).
 */
function newAttemptState(
  fileState: MatcherState,
  test: TestTask,
  nameSeparator: string,
): MatcherState {
  const {
    expectedAssertionsNumberError: _number,
    isExpectingAssertionsError: _expecting,
    ...carried
  } = fileState
  return { ...carried, ...counters(), currentTestName: test.fullName.join(nameSeparator) }
}
