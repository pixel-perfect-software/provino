// What the policy corpus compares: a fixture's tests as a golden records them, and as Provino
// runs them (`run-policy.ts`), in one shape, keyed by `testKey`.
import path from 'node:path'
import { type Fixture, type FixtureProfile, testFilesFor } from '../fixture.ts'
import { readGolden } from '../golden.ts'
import { createNormalizer, testKey } from '../normalize.ts'
import type { PolicyFlip, PolicyProfile } from './profiles.ts'
import { runPolicyFileInChild } from './run-child.ts'

/** A failure as a golden records it: the name, normalized message, matcher and user frame. */
export interface ObservedError {
  readonly name?: string
  readonly message: string
  readonly matcher?: string
  readonly userFrame?: string
}

/** A test as the comparison sees it. */
export interface ObservedTest {
  readonly status: string
  readonly errors: readonly ObservedError[]
  readonly passingAssertions: number
}

/** Tests by `testKey`. */
export type ObservedTests = ReadonlyMap<string, ObservedTest>

/** A key of an error without the fields it doesn't have, so two shapes compare with `deepEqual`. */
function observedError({ name, message, matcher, userFrame }: ObservedError): ObservedError {
  return {
    ...(name === undefined ? {} : { name }),
    message,
    ...(matcher === undefined ? {} : { matcher }),
    ...(userFrame === undefined ? {} : { userFrame }),
  }
}

/** The tests of `fixture`'s golden for `runner`. */
export async function recorded(fixture: Fixture, runner: FixtureProfile): Promise<ObservedTests> {
  const golden = await readGolden(fixture.dir, runner)
  const tests = new Map<string, ObservedTest>()
  for (const file of golden.files) {
    for (const test of file.tests) {
      tests.set(testKey(test.id), {
        status: test.status,
        errors: test.errors.map(observedError),
        passingAssertions: test.passingAssertions ?? 0,
      })
    }
  }
  return tests
}

/**
 * The tests of `fixture`'s files for `profile`, run through core under that profile's policy in a
 * child process, from the fixture's directory (as the recorder ran them), so a stack's paths
 * normalize the same way.
 */
export async function observed(
  fixture: Fixture,
  profile: PolicyProfile,
  flip?: PolicyFlip,
): Promise<ObservedTests> {
  const normalizer = createNormalizer({ rootDir: fixture.dir })
  const tests = new Map<string, ObservedTest>()
  for (const testFile of testFilesFor(fixture.files, profile)) {
    const run = await runPolicyFileInChild(
      path.join(fixture.dir, testFile),
      fixture.dir,
      profile,
      flip,
    )
    for (const test of run) {
      tests.set(testKey({ file: testFile, path: test.path, dupIndex: test.dupIndex }), {
        status: test.status,
        errors: test.failures.map(({ text, matcher }) =>
          observedError(normalizer.error(text, matcher)),
        ),
        passingAssertions: test.passingAssertions,
      })
    }
  }
  return tests
}
