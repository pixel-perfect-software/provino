// How `policy-truth.test.ts` asks a corpus whether it would catch a wrong value (T1.7): run a
// fixture through Provino's engine under a policy and list what the corpus check itself would fail
// on, with its own comparison and its own allowances (the runtime corpus's pinned collection error
// codes, the mock and mod corpora's declared cases). `[]` means the check passes. A corpus claim
// holds when the dialect's own policy gives `[]` and every flipped value it rejects gives a
// problem. No runner starts.
import path from 'node:path'
import type { HoistPolicy, Policy } from '@provino/types'
import { expectCorpusProblems } from '../expect-corpus/compare.ts'
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
  declaredProblems,
  sameOrder,
} from '../mock-corpus/compare.ts'
import { MOCK_DECLARED } from '../mock-corpus/declared.ts'
import { runMockFile } from '../mock-corpus/run-mock.ts'
import { MOD_DECLARED } from '../mod-corpus/declared.ts'
import { runModFile } from '../mod-corpus/run-mod.ts'
import { assertRunMatchesGolden } from '../runtime-corpus/compare.ts'
import { goldenExpectations } from '../runtime-corpus/expectations.ts'
import { runUnderCore } from '../runtime-corpus/run-core.ts'
import type { CorpusName } from './evidence.ts'

/** What a corpus run needs from a dialect: its resolved policy, its hoisting rules, its profile. */
export interface Subject {
  readonly profile: FixtureProfile
  readonly policy: Policy
  readonly hoist: HoistPolicy
}

/** The corpora `corpusProblems` runs: every one but the hoist corpus, which flips keys itself. */
export type RunCorpus = Exclude<CorpusName, 'hoist'>

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

/** A process imports a test file once; each later expect-corpus run imports it under a query. */
let expectRuns = 0

/**
 * What the corpus check would fail on for a run of `fixtureId` under `subject`: `[]` when it
 * passes. Each corpus's comparison is the one its own test makes, with that test's allowances.
 */
export async function corpusProblems(
  corpus: RunCorpus,
  fixtureId: string,
  subject: Subject,
): Promise<string[]> {
  const fixture = await fixtureById(fixtureId)
  const { profile, policy } = subject
  const label = `${fixture.id} (${profile})`

  if (corpus === 'expect') {
    if (profile !== 'jest') throw new Error(`the expect corpus is Jest's, not ${profile}'s`)
    expectRuns += 1
    return await expectCorpusProblems(fixture, policy.core, {
      expectPolicy: policy.expect,
      ...(expectRuns === 1 ? {} : { importQuery: `policy-truth=${expectRuns}` }),
    })
  }

  const testFile = oneTestFile(fixture, profile)
  const golden = await readGolden(fixture.dir, profile)
  const [goldenFile] = golden.files
  if (goldenFile === undefined) throw new Error(`${label} has no golden file`)

  if (corpus === 'runtime') {
    const run = await runUnderCore(path.join(fixture.dir, testFile), fixture.dir, policy.core)
    // As the corpus check: its message, retry-log and declared-trace expectations too.
    return caught(() =>
      assertRunMatchesGolden(run, golden, goldenExpectations(fixture.id, label, testFile)),
    )
  }

  const crash = fixture.manifest.expectCrash?.[profile]
  const problems: string[] = []
  let trace: readonly string[]
  if (corpus === 'mock') {
    const run = await runMockFile(
      path.join(fixture.dir, testFile),
      fixture.dir,
      policy.core,
      policy.mock,
      profile === 'jest' ? 'jest' : 'vi',
      fixture.manifest.mockCleanup ?? {},
    )
    trace = run.trace
    if (run.tests.length === 0) problems.push('the file ran no test')
    // As `mock-corpus.test.ts`: a crashed golden's tests must all pass here (DV7).
    if (crash !== undefined) {
      if (run.tests.some((t) => t.status !== 'passed')) problems.push('a test did not pass')
    } else {
      problems.push(...caught(() => assertTestsMatchGolden(run, goldenFile)))
      problems.push(...caught(() => assertFileOutcome(run, goldenFile)))
    }
  } else {
    const run = await runModFile(fixture, testFile, {
      facade: profile === 'jest' ? 'jest' : 'vi',
      core: policy.core,
      mock: policy.mock,
      module: policy.module,
      hoist: subject.hoist,
    })
    trace = run.trace
    // As `mod-corpus.test.ts`: a crash must crash for the golden's cause.
    if (crash !== undefined) {
      if (run.fileStatus !== 'crashed') problems.push('the file did not crash')
      const cause = (line: string): string => line.replace(/^[A-Za-z]*Error: /, '')
      const raised = run.collectionErrors.map((e) =>
        cause(causeText(e.message.replaceAll(run.root, '<root>'))),
      )
      const wanted = cause(causeText(goldenFile.fileError?.message ?? ''))
      if (JSON.stringify(raised) !== JSON.stringify([wanted])) problems.push('the crash cause')
    } else {
      if (run.tests.length === 0) problems.push('the file ran no test')
      problems.push(...caught(() => assertTestsMatchGolden(run, goldenFile)))
      problems.push(...caught(() => assertFileOutcome(run, goldenFile)))
    }
  }
  const wanted = golden.trace ?? []
  const results = compareObservations(wanted, trace)
  // The mock check wants a case from every fixture; the mod check only from one that doesn't crash.
  if (results.length === 0 && (corpus === 'mock' || crash === undefined)) {
    problems.push('the fixture observed no case')
  }
  if (!sameOrder(wanted, trace)) problems.push('the cases came in another order')
  const declared = corpus === 'mock' ? MOCK_DECLARED : MOD_DECLARED
  problems.push(...declaredProblems(label, results, declared, new Set()))
  return problems
}

/** Errors that escaped a run: a rejected factory nothing awaited, a throwing timer left behind. */
export interface StrayErrors {
  readonly errors: readonly string[]
  /** Puts the process's own listeners back. */
  restore(): void
}

/**
 * Swaps the process's unhandled-rejection and uncaught-exception listeners for ones that record,
 * until `restore`, so a flipped policy that leaves a rejected factory or a throwing timer behind
 * can't crash the test process. What they record is never evidence: an error can surface long
 * after the run that caused it, during another.
 */
export function captureStrayErrors(): StrayErrors {
  const events = ['unhandledRejection', 'uncaughtException'] as const
  const saved = events.map((event) => [event, process.rawListeners(event)] as const)
  const errors: string[] = []
  const record = (error: unknown): void => {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  for (const event of events) {
    process.removeAllListeners(event)
    process.on(event, record)
  }
  return {
    errors,
    restore() {
      for (const [event, listeners] of saved) {
        process.removeAllListeners(event)
        for (const listener of listeners)
          process.on(event, listener as (...args: unknown[]) => void)
      }
    },
  }
}
