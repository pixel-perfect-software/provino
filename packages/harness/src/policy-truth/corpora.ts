// How `policy-truth.test.ts` asks a corpus whether it would catch a wrong value (T1.7): run a
// fixture through Provino's engine under a policy and list where the run disagrees with the
// fixture's golden, by the corpus check's own comparison. A corpus claim holds when the dialect's
// own policy gives the same problems as the corpus check allows (none, or its declared cases) and
// each flipped value gives one more. No runner starts.
import path from 'node:path'
import type { HoistPolicy, Policy } from '@provino/types'
import {
  defaultFixturesRoot,
  type Fixture,
  type FixtureProfile,
  readFixture,
  testFilesFor,
} from '../fixture.ts'
import { readGolden } from '../golden.ts'
import {
  assertFileOutcome,
  assertTestsMatchGolden,
  causeText,
  compareObservations,
  sameOrder,
} from '../mock-corpus/compare.ts'
import { runMockFile } from '../mock-corpus/run-mock.ts'
import { runModFile } from '../mod-corpus/run-mod.ts'
import { assertRunMatchesGolden } from '../runtime-corpus/compare.ts'
import { runUnderCore } from '../runtime-corpus/run-core.ts'
import type { CorpusName } from './evidence.ts'

/** What a corpus run needs from a dialect: its resolved policy, its hoisting rules, its profile. */
export interface Subject {
  readonly profile: FixtureProfile
  readonly policy: Policy
  readonly hoist: HoistPolicy
}

const fixtureCache = new Map<string, Promise<Fixture>>()

/** A fixture by id (`runtime/hook-order`), read once. */
export function fixtureById(id: string): Promise<Fixture> {
  let found = fixtureCache.get(id)
  if (found === undefined) {
    found = readFixture(path.join(defaultFixturesRoot(), id))
    fixtureCache.set(id, found)
  }
  return found
}

function caught(run: () => void): string[] {
  try {
    run()
    return []
  } catch (error) {
    return [error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)]
  }
}

function oneTestFile(fixture: Fixture, profile: FixtureProfile): string {
  const files = testFilesFor(fixture.files, profile)
  const [testFile] = files
  if (testFile === undefined || files.length !== 1) {
    throw new Error(`${fixture.id} (${profile}) needs exactly one test file`)
  }
  return testFile
}

/**
 * Where a run of `fixtureId` under `subject` disagrees with its golden, as the corpus check
 * compares: a list of problems, `[]` when it agrees. The runtime corpus's collection error code is
 * taken from the run itself, so a flip that changes only the code is not counted (the check's
 * table pins the code; this asks whether the outcome moved).
 */
export async function corpusProblems(
  corpus: Exclude<CorpusName, 'hoist'>,
  fixtureId: string,
  subject: Subject,
): Promise<string[]> {
  return await withStrayErrorsCaught(() => runAndCompare(corpus, fixtureId, subject))
}

/**
 * Runs `run` with the process's unhandled-rejection and uncaught-exception listeners swapped for
 * ones that record, so a flipped policy that leaves a rejected factory or a throwing timer behind is
 * one more problem, not a crash of the test process. The listeners come back after two macrotasks,
 * once whatever the run left has settled. Tests in a file run one at a time, so nothing else runs
 * meanwhile.
 */
async function withStrayErrorsCaught(run: () => Promise<string[]>): Promise<string[]> {
  const events = ['unhandledRejection', 'uncaughtException'] as const
  const saved = events.map((event) => [event, process.rawListeners(event)] as const)
  const stray: string[] = []
  const record = (error: unknown): void => {
    stray.push(`stray error: ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const event of events) {
    process.removeAllListeners(event)
    process.on(event, record)
  }
  try {
    const problems = await run()
    for (let tick = 0; tick < 2; tick++) await new Promise((resolve) => setImmediate(resolve))
    return [...problems, ...stray]
  } finally {
    for (const [event, listeners] of saved) {
      process.removeAllListeners(event)
      for (const listener of listeners) process.on(event, listener as (...args: unknown[]) => void)
    }
  }
}

async function runAndCompare(
  corpus: Exclude<CorpusName, 'hoist'>,
  fixtureId: string,
  subject: Subject,
): Promise<string[]> {
  const fixture = await fixtureById(fixtureId)
  const { profile, policy } = subject
  const testFile = oneTestFile(fixture, profile)
  const golden = await readGolden(fixture.dir, profile)
  const [goldenFile] = golden.files
  if (goldenFile === undefined) throw new Error(`${fixtureId} (${profile}) has no golden file`)

  if (corpus === 'runtime') {
    const run = await runUnderCore(path.join(fixture.dir, testFile), fixture.dir, policy.core)
    const code = run.collectionErrors[0]?.code
    return caught(() =>
      assertRunMatchesGolden(run, golden, {
        testFile,
        ...(typeof code === 'string' ? { collectionErrorCode: code as never } : {}),
      }),
    )
  }

  const run =
    corpus === 'mock'
      ? await runMockFile(
          path.join(fixture.dir, testFile),
          fixture.dir,
          policy.core,
          policy.mock,
          profile === 'jest' ? 'jest' : 'vi',
          fixture.manifest.mockCleanup ?? {},
        )
      : await runModFile(fixture, testFile, {
          facade: profile === 'jest' ? 'jest' : 'vi',
          core: policy.core,
          mock: policy.mock,
          module: policy.module,
          hoist: subject.hoist,
          ...(profile === 'jest' ? { prefixTransformErrors: true } : {}),
        })
  const problems: string[] = []
  const crash = fixture.manifest.expectCrash?.[profile]
  if (crash !== undefined) {
    if (run.fileStatus !== 'crashed') problems.push('the file did not crash')
    if (corpus === 'mod' && 'root' in run) {
      const cause = (line: string): string => line.replace(/^[A-Za-z]*Error: /, '')
      const raised = run.collectionErrors.map((e) =>
        cause(causeText(e.message.replaceAll(String(run.root), '<root>'))),
      )
      const wanted = cause(causeText(goldenFile.fileError?.message ?? ''))
      if (JSON.stringify(raised) !== JSON.stringify([wanted])) problems.push('the crash cause')
    }
  } else {
    problems.push(...caught(() => assertTestsMatchGolden(run, goldenFile)))
    problems.push(...caught(() => assertFileOutcome(run, goldenFile)))
  }
  const wanted = golden.trace ?? []
  for (const result of compareObservations(wanted, run.trace)) {
    if (!result.matches) problems.push(`case "${result.id}": ${result.got ?? '(missing)'}`)
  }
  if (!sameOrder(wanted, run.trace)) problems.push('the cases came in another order')
  return problems
}
