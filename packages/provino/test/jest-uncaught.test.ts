// An error the code never handles is charged as Jest 30.5.2 charges it. `cli/uncaught-during-test`
// records one file per timing while a file runs: a timer that throws while its test runs, after its
// test ended (while the next test runs, during a later describe's `beforeAll`, during the file's
// `afterAll`), a rejection nobody handles while its test runs and one made after it ended, and a
// timer no test owns. jest-circus keeps each error in its owner's `test.errors` (the test whose async
// context raised it, even an ended one) and reads them when the run ends, so the owner is a failed
// test in the results and the file fails; an error no test owns fails the file as `Test suite failed
// to run`. `provino jest` must print the same and write the same results file.
//
// After circus has torn its handlers down, Jest has no outcome of its own: Node's report of the
// error ends Jest's process (in band) or kills the worker. Provino keeps a clean failure there
// (D7): the declared differences below pin both sides.
import { describe, it } from 'node:test'
import { assertMatchesGolden, type DeclaredDifference, provinoOn } from './recorded-run.ts'

const RESULTS = 'json:.harness-out/jest.json'

/** The part of a results file the after-run pins are about. */
function outcome(capture: unknown): unknown {
  if (capture === null || typeof capture !== 'object') return capture
  const run = capture as Readonly<Record<string, unknown>>
  const files = (run.testResults ?? []) as readonly Readonly<Record<string, unknown>>[]
  return {
    success: run.success,
    numFailedTests: run.numFailedTests,
    numRuntimeErrorTestSuites: run.numRuntimeErrorTestSuites,
    files: files.map((file) => ({
      name: file.name,
      status: file.status,
      message: file.message,
      tests: ((file.assertionResults ?? []) as readonly Readonly<Record<string, unknown>>[]).map(
        (test) => [test.fullName, test.status],
      ),
    })),
  }
}

/** What Provino gives for the file whose last test leaves a rejection, in band or in a worker. */
const FAILS_THE_TEST: {
  readonly stderr: string
  readonly results: unknown
} = {
  stderr: [
    'FAIL ./leaves-rejection.test.ts',
    '  ● leaves a rejection nobody handles',
    'Tests:       1 failed, 1 total',
  ].join('\n'),
  results: {
    success: false,
    numFailedTests: 1,
    numRuntimeErrorTestSuites: 0,
    files: [
      {
        name: '<root>/leaves-rejection.test.ts',
        status: 'failed',
        message: [
          '  ● leaves a rejection nobody handles',
          '',
          '    rejected as its test ends',
          '',
          "      1 | test('leaves a rejection nobody handles', () => {",
          "    > 2 |   void Promise.reject(new Error('rejected as its test ends'))",
          '        |                       ^',
          '      3 | })',
          '      4 |',
          '',
          '<frames>',
          '',
        ].join('\n'),
        tests: [['leaves a rejection nobody handles', 'failed']],
      },
    ],
  },
}

const AFTER_CIRCUS =
  'D7: the rejection the last test left is reported after circus tore its handlers down, and Node’s report ends Jest’s process or worker; Provino still listens, and fails the test, as circus would have a turn earlier'

const DECLARED: Readonly<Record<string, Readonly<Record<string, DeclaredDifference>>>> = {
  'cli/uncaught-after-run': {
    stderr: {
      golden: 'Error: rejected as its test ends',
      provino: FAILS_THE_TEST.stderr,
      reason: `${AFTER_CIRCUS}: Jest prints Node’s report and no header`,
    },
    [RESULTS]: {
      golden: null,
      provino: FAILS_THE_TEST.results,
      reason: `${AFTER_CIRCUS}: Jest writes no results file`,
      view: outcome,
    },
  },
  'cli/uncaught-after-run-worker': {
    stderr: {
      golden: [
        'Error: rejected as its test ends',
        'Error: rejected as its test ends',
        'Error: rejected as its test ends',
        'Error: rejected as its test ends',
        'FAIL ./leaves-rejection.test.ts',
        '  ● Test suite failed to run',
        '    Jest worker encountered 4 child process exceptions, exceeding retry limit',
        'Tests:       0 total',
      ].join('\n'),
      provino: FAILS_THE_TEST.stderr,
      reason: `${AFTER_CIRCUS}: jest-worker runs the file in 4 workers, then fails it to run`,
    },
    [RESULTS]: {
      golden: {
        success: false,
        numFailedTests: 0,
        numRuntimeErrorTestSuites: 1,
        files: [
          {
            name: '<root>/leaves-rejection.test.ts',
            status: 'failed',
            message: [
              '  ● Test suite failed to run',
              '',
              '    Jest worker encountered 4 child process exceptions, exceeding retry limit',
              '',
              '<frames>',
              '',
            ].join('\n'),
            tests: [],
          },
        ],
      },
      provino: FAILS_THE_TEST.results,
      reason: `${AFTER_CIRCUS}: Jest's file has no test result, only the worker's testExecError`,
      view: outcome,
    },
  },
  'cli/uncaught-after-file-unowned': {
    stderr: {
      golden: [
        'PASS ./first.test.ts',
        'Error: thrown by a timer no test owns',
        'PASS ./second.test.ts',
        'Tests:       2 passed, 2 total',
      ].join('\n'),
      provino: [
        'PASS ./first.test.ts',
        'PASS ./second.test.ts',
        'Tests:       2 passed, 2 total',
      ].join('\n'),
      reason:
        'the first file’s worker is idle when the timer throws: Jest’s worker prints the error on its stderr, which Jest passes on; Provino stops a worker with no file left to run before the timer fires',
    },
  },
  'cli/uncaught-timer-of-earlier-file': {
    stderr: {
      golden: [
        'PASS ./first.test.ts',
        'FAIL ./second.test.ts',
        '  ● b fails on its own',
        '    the second file fails anyway',
        '  ● Test suite failed to run',
        '    thrown by a timer of the first file',
        'Tests:       1 failed, 2 passed, 3 total',
      ].join('\n'),
      provino: [
        'PASS ./first.test.ts',
        'FAIL ./second.test.ts',
        '  ● b fails on its own',
        '    the second file fails anyway',
        '  ● Unhandled error',
        '    thrown by a timer of the first file',
        'Tests:       1 failed, 2 passed, 3 total',
      ].join('\n'),
      reason:
        'circus is loaded per file, so the second file’s handlers take the first file’s timer as their own unowned error (its testExecError); Provino charges it to the first file’s test, whose async context raised it, and, that file being over, prints it as the run’s',
    },
    [RESULTS]: {
      golden: { second: 'failed', numRuntimeErrorTestSuites: 1, timerInSecond: true },
      provino: { second: 'failed', numRuntimeErrorTestSuites: 0, timerInSecond: false },
      reason: 'as stderr: the error is not the second file’s testExecError under Provino',
      view: (capture) => {
        const run = outcome(capture) as {
          readonly numRuntimeErrorTestSuites: unknown
          readonly files: readonly { readonly status: unknown; readonly message: unknown }[]
        }
        const second = run.files[1]
        return {
          second: second?.status,
          numRuntimeErrorTestSuites: run.numRuntimeErrorTestSuites,
          timerInSecond: String(second?.message).includes('thrown by a timer of the first file'),
        }
      },
    },
  },
}

describe('provino jest charges an unhandled error to its owner as Jest 30.5.2 does', () => {
  for (const [id, what] of [
    ['cli/uncaught-during-test', 'the exit code, the failure blocks and the results file'],
    ['cli/hooks-only-describe', 'each hook of a describe with no tests is the file’s error'],
    [
      'cli/retry-entire-describe-unowned-rejection',
      'an unowned rejection during a describe attempt ends its retries',
    ],
    ['cli/uncaught-after-run-timer', 'a timer that throws once the run is over ends the process'],
    ['cli/uncaught-after-file-unowned', 'an error no test owns, in an idle worker, fails no file'],
    ['cli/uncaught-timer-of-earlier-file', 'a timer of the first file fires while the second runs'],
    ['cli/uncaught-after-run', 'a rejection the last test leaves, in band, fails that test'],
    ['cli/uncaught-after-run-worker', 'a rejection the last test leaves, in a worker, fails it'],
  ] as const) {
    it(`${id}: ${what}`, async () => {
      const declared = DECLARED[id]
      assertMatchesGolden(id, await provinoOn(id), declared === undefined ? {} : { declared })
    })
  }
})
