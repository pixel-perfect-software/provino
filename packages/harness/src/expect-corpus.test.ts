// B08's corpus check (T7.5): every `fixtures/expect/messages` fixture, run through `@provino/core`
// with the Jest dialect's `expect`, gives the Jest golden's tests: status, each failure's name,
// message, matcher and user frame (normalized by the same rules as the golden), and the
// passing-assertion count. Brief 8's "100% of the Jest message goldens match". The golden's
// `matcher` field is Jest's `failureDetails[i].matcherResult.name`; the run's is the same field of
// the `SerializedError.matcherResult` core now carries.
//
// Jest's `toThrow` prints a thrown error's stack with paths relative to `process.cwd()`, which
// was the fixture's directory when it was recorded, so each fixture runs from its directory.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { runExpectFile } from './expect-corpus/run-expect.ts'
import { defaultFixturesRoot, findFixtures, readFixture, testFilesFor } from './fixture.ts'
import { type Golden, goldenPath } from './golden.ts'
import { createNormalizer, testKey } from './normalize.ts'
import { corePolicyFor } from './runtime-corpus/profiles.ts'

const root = path.join(defaultFixturesRoot(), 'expect', 'messages')
const dirs = await findFixtures(root)
const fixtures = await Promise.all(dirs.map((dir) => readFixture(dir)))

test('the message corpus is there', () => {
  assert.ok(dirs.length >= 10, `expected the B08 corpus under ${root}, found ${dirs.length}`)
})

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

for (const fixture of fixtures) {
  describe(fixture.id, () => {
    test('jest', async () => {
      const golden = JSON.parse(await readFile(goldenPath(fixture.dir, 'jest'), 'utf8')) as Golden
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
            corePolicyFor.jest,
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

      assert.deepEqual([...actual.keys()].toSorted(), [...expected.keys()].toSorted(), 'the tests')
      const mismatched: string[] = []
      for (const [key, want] of expected) {
        const got = actual.get(key)
        try {
          assert.deepEqual(got, want)
        } catch (error) {
          mismatched.push(`${key}\n${(error as Error).message}`)
        }
      }
      assert.deepEqual(mismatched, [], `${mismatched.length} of ${expected.size} tests differ`)
    })
  })
}
