// Per-test matcher state (T7.2, Track 7 R1). Jest keeps one global `MatcherState`, so
// `expect.assertions(n)` miscounts under `test.concurrent` (spike P4/P5). Here every run of a test
// (each retry attempt of each repeat) gets its own state, found through the current-test lookup,
// so the global `expect` counts each run separately. A run's state is never replaced: a timed-out
// attempt whose body is still running keeps counting into its own. Outside a test (suite hooks, a
// file's top level) the file's state is current, as Jest's one state would be.
import type { CurrentTest, Frame, MatcherState, TestTask } from '@provino/types'
import { freshCounters, hasCounts, moveCounters } from './internal/counters.ts'

/**
 * Options for `createStateSource`.
 * @public
 */
export interface StateSourceOptions {
  /** Joins a test's full name into `currentTestName`: the core policy's `nameSeparator`. */
  readonly nameSeparator: string
  /** Whether diffs show every line: `ExpectPolicy.expand` (Jest sets it once, from `--expand`). */
  readonly expand: boolean
  /**
   * `ExpectPolicy.outsideTestCounts`, `'drop'` when left out. Under `'next-test'` the counters
   * made outside a test go to one attempt: in a sequential run the next test to end, as Jest's
   * one state carries them. Under concurrency, the first attempt that asserts, or that ends with
   * none having asserted (Jest shares one state; the declared improvement).
   */
  readonly outsideTestCounts?: 'drop' | 'next-test'
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
  /**
   * The state of one run of a test (its attempt and repeat, as `test-attempt-end` reports them),
   * if that run read or counted any. A pure lookup: it moves nothing.
   */
  stateOf(testId: string, run: TestRun): MatcherState | undefined
  /**
   * Ends a run: its state, made now when the run made none and (under `outsideTestCounts:
   * 'next-test'`) the file state holds counts to take, else what `stateOf` gives. The end-of-test
   * check calls it once, where Jest's `test_done` reads the counters.
   */
  settle(testId: string, run: TestRun): MatcherState | undefined
}

/**
 * Which run of a test: the retry attempt and the repeat, both from 0.
 * @public
 */
export interface TestRun {
  readonly attempt: number
  readonly repeat: number
}

/** A run's key among a test's runs: a number, so the per-assertion lookup builds no string. */
const runKey = ({ attempt, repeat }: TestRun): number => repeat * 1_048_576 + attempt

/**
 * Builds the state source from the worker's current-test lookup (core's `currentTest`). Typed by
 * `@provino/types`' `CurrentTest`, so the engine never imports core (Track 7 §Per-test state).
 * @public
 */
export function createStateSource(
  currentTest: CurrentTest,
  options: StateSourceOptions,
): StateSource {
  const { nameSeparator, expand, outsideTestCounts = 'drop' } = options
  const carry = outsideTestCounts === 'next-test'
  let fileState = newFileState(expand, undefined)
  /** Each test's runs, by `runKey`. */
  let tests = new Map<string, Map<number, MatcherState>>()
  // The last frame looked up and its state: a test body's assertions share one frame object, and
  // a run's state is never replaced, so this hit needs no invalidation within a file.
  let lastFrame: Frame | undefined
  let lastState = fileState

  return {
    current(): MatcherState {
      const frame = currentTest.get()
      if (frame?.test == null) return fileState
      if (frame === lastFrame) return lastState
      const { test } = frame
      let runs = tests.get(test.id)
      if (runs === undefined) {
        runs = new Map()
        tests.set(test.id, runs)
      }
      const key = runKey(frame)
      let state = runs.get(key)
      if (state === undefined) {
        state = newAttemptState(fileState, test.id, test, nameSeparator)
        if (carry) moveCounters(fileState, state)
        runs.set(key, state)
      }
      lastFrame = frame
      lastState = state
      return state
    },
    file(): MatcherState {
      return fileState
    },
    startFile(testPath: string | undefined): void {
      fileState = newFileState(expand, testPath)
      tests = new Map()
      lastFrame = undefined
    },
    stateOf(testId: string, run: TestRun): MatcherState | undefined {
      return tests.get(testId)?.get(runKey(run))
    },
    settle(testId: string, run: TestRun): MatcherState | undefined {
      const found = tests.get(testId)?.get(runKey(run))
      if (found !== undefined || !carry || !hasCounts(fileState)) return found
      // An attempt that made no assertion of its own still ends: it takes what was counted before
      // it, as Jest's `test_done` reads the state whatever the test did (`expect.hasAssertions()`
      // from a `beforeAll` fails it).
      const state = newAttemptState(fileState, testId, undefined, nameSeparator)
      moveCounters(fileState, state)
      let runs = tests.get(testId)
      if (runs === undefined) {
        runs = new Map()
        tests.set(testId, runs)
      }
      runs.set(runKey(run), state)
      return state
    },
  }
}

function newFileState(expand: boolean, testPath: string | undefined): MatcherState {
  return {
    ...freshCounters(),
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
  testId: string,
  test: TestTask | undefined,
  nameSeparator: string,
): MatcherState {
  const {
    expectedAssertionsNumberError: _number,
    isExpectingAssertionsError: _expecting,
    ...carried
  } = fileState
  return {
    ...carried,
    ...freshCounters(),
    currentTestId: testId,
    ...(test === undefined
      ? {}
      : {
          currentTestName: test.fullName.join(nameSeparator),
          currentTestPath: test.fullName,
          testFailing: test.expectFail,
        }),
  }
}
