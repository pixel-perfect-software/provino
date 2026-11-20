// The policy corpus's declared divergences (T7.8). Every entry pins what Provino gives; see
// `compare.ts` for how an entry is held to it: an undeclared difference fails, so does an entry
// the run no longer needs, and so does one whose pinned observation is not what the run gives.
import type { Declared } from './compare.ts'

const CONCURRENT = 'assertions-concurrent.test.ts::global expect under test.concurrent'

/** P4/P5: the improvement the build plan names (Track 7 F5, T7.8, risk table). */
const PER_TEST_COUNT =
  'a count per test under test.concurrent: Jest shares one counter across the five tests, so ' +
  'the two that miss their count pass there (P4/P5, our documented improvement)'

/**
 * Differences from the Jest goldens, keyed `fixture (jest) test`.
 */
export const JEST_DECLARED: Readonly<Record<string, Declared>> = {
  [`assertions-concurrent (jest) ${CONCURRENT} › assertions(1) missed after 80 ms#0`]: {
    reason: PER_TEST_COUNT,
    ours: {
      status: 'failed',
      errors: [
        {
          name: 'Error',
          message:
            'Error: expect.assertions(1)\n\nExpected one assertion to be called but received zero assertion calls.',
          userFrame: '<root>/assertions-concurrent.test.ts:25:12',
        },
      ],
      passingAssertions: 0,
    },
  },
  [`assertions-concurrent (jest) ${CONCURRENT} › hasAssertions missed after 100 ms#0`]: {
    reason: PER_TEST_COUNT,
    ours: {
      status: 'failed',
      errors: [
        {
          name: 'Error',
          message:
            'Error: expect.hasAssertions()\n\nExpected at least one assertion to be called but received none.',
          userFrame: '<root>/assertions-concurrent.test.ts:30:12',
        },
      ],
      passingAssertions: 0,
    },
  },
}

const COUNT = 'assertions-count.test.ts::expect.assertions'
const SOFT = 'soft-and-poll.vitest.test.ts::expect.soft'

/** Vitest makes the count error in its runner, after the test: no frame of the test's. */
const COUNT_FRAME =
  "the count error points at the `expect.assertions` call; Vitest's is made by its runner after " +
  'the test, so it has no frame of the test (an improvement)'

const countError = (expected: number, actual: number, line: number) => ({
  name: 'Error',
  message: `Error: expected number of assertions to be ${expected}, but got ${actual}`,
  userFrame: `<root>/assertions-count.test.ts:${line}:12`,
})

const toBeError = (received: number, expected: number, at: string) => ({
  name: 'AssertionError',
  message: `AssertionError: expected ${received} to be ${expected} // Object.is equality`,
  userFrame: `<root>/${at}`,
})

/**
 * Differences from the Vitest goldens, keyed `fixture (vitest) test`, compared in text (status and
 * every error, no passing count: Vitest's JSON has none). The eleven aliases Jest 30 removed
 * (`removed-aliases`) are in the Vitest dialect's own table (T7.6), as Vitest keeps them, so they
 * no longer differ.
 */
export const VITEST_DECLARED: Readonly<Record<string, Declared>> = {
  [`assertions-count (vitest) ${COUNT} › assertions(2) missed with one made#0`]: {
    reason: COUNT_FRAME,
    ours: { status: 'failed', errors: [countError(2, 1, 11)] },
  },
  [`assertions-count (vitest) ${COUNT} › assertions(1) exceeded with two made#0`]: {
    reason: COUNT_FRAME,
    ours: { status: 'failed', errors: [countError(1, 2, 16)] },
  },
  [`assertions-count (vitest) ${COUNT} › assertions(2) missed after a failed assertion#0`]: {
    reason:
      'Vitest checks the counts only on a test whose body passed; Provino adds the count error to ' +
      "a failed test too (`@provino/expect`'s end-of-test check, a known limit: no policy key says " +
      'which; the test fails either way)',
    ours: {
      status: 'failed',
      errors: [toBeError(1, 2, 'assertions-count.test.ts:35:15'), countError(2, 1, 34)],
    },
  },
  [`soft-and-poll (vitest) ${SOFT} › a soft failure then a failing hard assertion stops the test#0`]:
    {
      reason:
        'the errors come in another order: Vitest pushes a soft failure onto the result as it ' +
        "happens, ahead of the error the body throws; Provino's end-of-test check adds the held " +
        'failures after it (a known limit of the order core collects errors in)',
      ours: {
        status: 'failed',
        errors: [
          toBeError(2, 3, 'soft-and-poll.vitest.test.ts:14:15'),
          toBeError(1, 2, 'soft-and-poll.vitest.test.ts:13:20'),
        ],
      },
    },
}
