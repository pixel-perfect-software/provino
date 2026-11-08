// What B08's expect check asks of a fixture's Jest files run through core (T7.5): every test of the
// golden, with its status, each error's name, normalized message, matcher and user frame, and its
// passing-assertion count. One function, shared by `expect-corpus.test.ts` and T1.7's
// `policy-truth/corpora.ts`, so both hold a run to the same comparison.

import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { CorePolicy } from '@provino/types'
import { type Fixture, testFilesFor } from '../fixture.ts'
import { readGolden } from '../golden.ts'
import { createNormalizer, testKey } from '../normalize.ts'
import { type ExpectRunOptions, runExpectFile } from './run-expect.ts'

/**
 * A failure's comparable shape: `name`, `matcher` and `userFrame` are there only when the failure
 * has one.
 */
interface ComparableError {
  readonly name?: string
  readonly message: string
  readonly matcher?: string
  readonly userFrame?: string
}

/** A test's comparable shape: what both the golden and the run can say. */
interface Comparable {
  readonly status: string
  readonly errors: readonly ComparableError[]
  readonly passingAssertions: number
}

/** The comparable part of a golden error or a normalized failure, the same on both sides. */
function comparable({ name, message, matcher, userFrame }: ComparableError): ComparableError {
  return {
    ...(name === undefined ? {} : { name }),
    message,
    ...(matcher === undefined ? {} : { matcher }),
    ...(userFrame === undefined ? {} : { userFrame }),
  }
}

/**
 * Where a run of the fixture's Jest files under `policy` (and `options`' expect policy) disagrees
 * with its Jest golden: a test one side has and the other lacks, or a test that differs. `[]` when
 * it agrees. Each file runs from the fixture's directory, because `toThrow` prints the thrown
 * error's stack relative to `process.cwd()`.
 */
export async function expectCorpusProblems(
  fixture: Fixture,
  policy: CorePolicy,
  options: ExpectRunOptions = {},
): Promise<string[]> {
  const golden = await readGolden(fixture.dir, 'jest')
  const expected = new Map<string, Comparable>()
  for (const file of golden.files) {
    for (const goldenTest of file.tests) {
      expected.set(testKey(goldenTest.id), {
        status: goldenTest.status,
        errors: goldenTest.errors.map(comparable),
        passingAssertions: goldenTest.passingAssertions ?? 0,
      })
    }
  }

  const actual = new Map<string, Comparable>()
  const normalizer = createNormalizer({ rootDir: fixture.dir })
  const cwd = process.cwd()
  process.chdir(fixture.dir)
  try {
    for (const testFile of testFilesFor(fixture.files, 'jest')) {
      const tests = await runExpectFile(
        path.join(fixture.dir, testFile),
        fixture.dir,
        policy,
        options,
      )
      for (const run of tests) {
        const key = testKey({ file: testFile, path: run.path, dupIndex: run.dupIndex })
        actual.set(key, {
          status: run.status,
          errors: run.failures.map(({ text, matcher }) =>
            comparable(normalizer.error(text, matcher)),
          ),
          passingAssertions: run.passingAssertions,
        })
      }
    }
  } finally {
    process.chdir(cwd)
  }

  const problems: string[] = []
  for (const key of new Set([...expected.keys(), ...actual.keys()])) {
    const want = expected.get(key)
    const got = actual.get(key)
    if (want === undefined) problems.push(`${key}: a test the golden doesn't have`)
    else if (got === undefined) problems.push(`${key}: the run has no such test`)
    else if (!isDeepStrictEqual(got, want)) {
      problems.push(`${key}: want ${JSON.stringify(want)}\n  got ${JSON.stringify(got)}`)
    }
  }
  return problems
}
