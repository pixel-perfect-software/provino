// The snapshot check (T7.9, T7.10, B17b): every `fixtures/snapshot/` fixture, run end to end through
// `provino/node`'s `run()` and a forked worker, must leave what the real runner left. For each
// pair of fixture and profile, with the flags the recording had (CI or not, `-u`, a name pattern,
// the update variable):
//   - the exit code is the golden's (obsolete snapshots, CI and the update flag included);
//   - every test of the files that ran has the golden's status;
//   - every captured `.snap` of those files is byte for byte the golden's, and so is any other
//     captured file (an inline snapshot's source).
// The `jest` profile is Provino with the Jest dialect; the `vitest` profile is the same with
// Vitest's snapshot slice over it (see `snapshot-corpus/run-snapshot.ts`). A file that calls `vi`
// can't run, and a fixture of such files is evidence only.
//
// One divergence is declared, and pinned to what Provino does: an inline snapshot with nothing
// written in it would be written into the test file, which nothing does yet (T7.11), so the test
// fails naming T7.11 and the source is left as it was.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import {
  defaultFixturesRoot,
  FIXTURE_RUNNERS,
  type Fixture,
  findFixtures,
  readFixture,
  testFilesFor,
} from './fixture.ts'
import { readGolden } from './golden.ts'
import {
  runnableFiles,
  runSnapshotEndToEnd,
  type SnapshotEndToEnd,
} from './snapshot-corpus/run-snapshot.ts'

/** Per run deadline: a hang is a real flaw, not something to retry. */
const TIMEOUT_MS = 60_000
const ABORT_MARGIN_MS = 5_000

/**
 * The fixtures whose golden shows something Provino doesn't do yet, with why. Each is checked
 * against exactly what Provino does instead, and fails the day it stops differing.
 */
const DECLARED: Readonly<Record<string, string>> = {
  'snapshot/inline-written':
    'an inline snapshot with nothing in it is written into the test file by both runners; nothing writes inline snapshots yet (T7.11), so the test fails naming T7.11 and the source stays',
}

/** The pairs the check ran and the snapshot tests in them, pinned so it cannot pass by running nothing. */
const EXPECTED = { pairs: 42, evidenceOnly: 3, tests: 114 } as const

const fixtures: Fixture[] = await Promise.all(
  (await findFixtures(path.join(defaultFixturesRoot(), 'snapshot'))).map((dir) => readFixture(dir)),
)

const counted = { pairs: 0, evidenceOnly: 0, tests: 0 }
const declaredSeen = new Set<string>()
/** What each pair left, so the sabotage check can hold one profile against the other's golden. */
const left = new Map<string, SnapshotEndToEnd>()

/** The captured files a pair compares: the `.snap` of each file that ran, and any non-`.snap` file. */
function comparedFiles(captured: readonly string[], ran: readonly string[]): readonly string[] {
  return captured.filter((file) => {
    if (!file.endsWith('.snap')) return true
    return ran.some((test) => file === `__snapshots__/${path.posix.basename(test)}.snap`)
  })
}

for (const fixture of fixtures) {
  describe(fixture.id, () => {
    for (const profile of FIXTURE_RUNNERS) {
      if (!fixture.manifest.runners.includes(profile)) continue
      const ran = runnableFiles(fixture, profile)
      if (ran.length === 0) {
        counted.evidenceOnly++
        continue
      }
      test(profile, { timeout: TIMEOUT_MS }, async () => {
        const signal = AbortSignal.timeout(TIMEOUT_MS - ABORT_MARGIN_MS)
        const golden = await readGolden(fixture.dir, profile)
        const observed = golden.observed ?? {}
        const captured = Object.keys(observed.files ?? {})
        const result = await runSnapshotEndToEnd(fixture, profile, captured, signal)
        left.set(`${fixture.id} (${profile})`, result)
        counted.pairs++

        // The tests of the files that ran, by identity.
        const identity = (file: string, t: { id: { path: readonly string[]; dupIndex: number } }) =>
          `${file} ${t.id.path.join(' › ')}#${t.id.dupIndex}`
        const wanted = new Map<string, string>()
        for (const file of golden.files) {
          if (!ran.includes(file.file)) continue
          for (const t of file.tests) wanted.set(identity(file.file, t), t.status)
        }
        const got = new Map<string, string>()
        for (const file of result.normalized.files) {
          for (const t of file.tests) got.set(identity(file.file, t), t.status)
        }
        counted.tests += wanted.size

        const files = comparedFiles(captured, ran)
        if (Object.hasOwn(DECLARED, fixture.id)) {
          declaredSeen.add(fixture.id)
          assert.equal(result.exitCode, 1, 'the exit code')
          assert.deepEqual([...got.values()], ['failed'], 'the test fails')
          const messages = result.normalized.files.flatMap((f) =>
            f.tests.flatMap((t) => t.errors.map((e) => e.message)),
          )
          assert.ok(
            messages.some((message) => message.includes('T7.11')),
            `the failure names T7.11: ${messages.join(' | ')}`,
          )
          for (const file of files) {
            const original = await readFile(path.join(fixture.dir, file), 'utf8')
            assert.equal(result.files[file], original, `${file} is left as it was`)
          }
          return
        }

        assert.deepEqual([...got], [...wanted], `tests (stderr: ${result.stderr.slice(0, 400)})`)
        if (ran.length === testFilesFor(fixture.files, profile).length) {
          assert.equal(result.exitCode, observed.exitCode, 'the exit code')
        } else {
          // Files that call `vi` are left out, so the golden's code is not comparable: the files
          // that ran call for 1 when one of their tests failed, else 0.
          const failed = [...wanted.values()].includes('failed')
          assert.equal(result.exitCode, failed ? 1 : 0, 'the exit code of the files that ran')
        }
        for (const file of files) {
          assert.equal(result.files[file], observed.files?.[file], file)
        }
      })
    }
  })
}

describe('the check is not vacuous', () => {
  test('every declared divergence ran, and the totals are the ones pinned', () => {
    assert.deepEqual([...declaredSeen].sort(), Object.keys(DECLARED).sort())
    assert.deepEqual(counted, EXPECTED)
  })

  test('a profile can be told from the other: Vitest`s run does not leave Jest`s bytes', async () => {
    const fixture = fixtures.find((f) => f.id === 'snapshot/values')
    assert.ok(fixture !== undefined)
    const vitest = left.get('snapshot/values (vitest)')
    const jest = await readGolden(fixture.dir, 'jest')
    const file = '__snapshots__/values.test.ts.snap'
    assert.ok(vitest !== undefined && jest.observed?.files?.[file] !== undefined)
    assert.notEqual(vitest.files[file], jest.observed.files[file])
  })
})
