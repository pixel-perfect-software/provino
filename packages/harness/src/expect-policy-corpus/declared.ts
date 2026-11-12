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

/** The eleven aliases Jest 30 removed, which Vitest 5 keeps (`removed-aliases`). */
const ALIASES = [
  'toBeCalled',
  'toBeCalledTimes',
  'toBeCalledWith',
  'lastCalledWith',
  'nthCalledWith',
  'toReturn',
  'toReturnTimes',
  'toReturnWith',
  'lastReturnedWith',
  'nthReturnedWith',
  'toThrowError',
] as const

/**
 * Differences from the Vitest goldens' outcomes, keyed `fixture (vitest) test`. The Vitest `expect`
 * here runs over the Jest matcher table (the Vitest dialect's own is T7.6's), and Jest 30 has no
 * aliases, so each alias throws `is not a function` where Vitest passes it.
 */
export const VITEST_DECLARED: Readonly<Record<string, Declared>> = Object.fromEntries(
  ALIASES.map((alias): [string, Declared] => [
    `removed-aliases (vitest) removed-aliases.test.ts::aliases removed in Jest 30 › ${alias}#0`,
    {
      reason:
        "Vitest's matcher table, with the aliases it keeps, is T7.6's; the Jest table has none",
      ours: { status: 'failed', hasErrors: true },
    },
  ]),
)
