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
// can't run, and a fixture of such files is evidence only. The `native` profile (B28) is a project
// with no dialect and `globals: true`, held to the Jest recording: its `.snap` bytes, test statuses
// and exit codes (its failure text is Provino's own, D188). The fixtures it can't hold are listed in
// `NATIVE_EXCLUDED`, each with why.
//
// One divergence is declared, and pinned to what Provino does: under the `vitest` profile an
// inline snapshot with nothing written in it would be written into the test file, and Vitest's
// slice has no writer yet (T7.11's Vitest half), so the test fails naming T7.11 and the source is
// left as it was. Under `jest` the Jest dialect's writer writes it (B23d B1).
//
// Fixtures whose Jest config a generated `provino.config` can't carry (a preset and `testMatch`, the
// default `prettierPath` that finds the workspace's Prettier, a `snapshotResolver`) are evidence
// only here: `provino`'s `jest-inline-snapshots.test.ts` and `jest-snapshots.test.ts` run them
// through `provino jest` against the same goldens.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'provino'
import {
  defaultFixturesRoot,
  type Fixture,
  findFixtures,
  readFixture,
  testFilesFor,
} from './fixture.ts'
import { readGolden } from './golden.ts'
import {
  recordedRunner,
  runnableFiles,
  runSnapshotEndToEnd,
  SNAPSHOT_PROFILES,
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
  'snapshot/inline-written (vitest)':
    'an inline snapshot with nothing in it is written into the test file by both runners; Vitest`s slice has no writer yet (T7.11), so the test fails naming T7.11 and the source stays',
}

/** Fixtures `provino jest` holds instead (see the header), with the config the corpus can't carry. */
const HELD_BY_PROVINO_JEST: Readonly<Record<string, string>> = {
  'snapshot/inline-no-frame': 'a package installed under `node_modules`',
  'snapshot/inline-prettier': 'the default `prettierPath`, the workspace`s Prettier 3',
  'snapshot/inline-tsx': 'a `preset` transform and a `.tsx` `testMatch`',
  'snapshot/resolver-custom': '`snapshotResolver`',
  'snapshot/resolver-esm-default': '`snapshotResolver`',
  'snapshot/resolver-esm-named': '`snapshotResolver`',
  'snapshot/resolver-inconsistent': '`snapshotResolver`',
  'snapshot/resolver-missing-member': '`snapshotResolver`',
}

/**
 * The fixtures the `native` profile doesn't run, with why. The check fails when the list and the
 * fixtures that would otherwise run drift apart, so an entry goes when its reason does.
 */
const NATIVE_EXCLUDED: Readonly<Record<string, string>> = {
  'snapshot/mock-fn': "`jest.fn`/`vi.fn`: the native API's is `fn`",
  'snapshot/file-snapshot':
    "`toMatchFileSnapshot`, Vitest's slice: a `*.vitest.test.ts` file, recorded by Vitest only",
  'snapshot/format': '`snapshotFormat`, a Jest config key a native config has none of',
  'snapshot/serializers': '`snapshotSerializers`, a Jest config key a native config has none of',
  'snapshot/resolver-custom': '`snapshotResolver` is a Jest key',
  'snapshot/resolver-esm-default': '`snapshotResolver` is a Jest key',
  'snapshot/resolver-esm-named': '`snapshotResolver` is a Jest key',
  'snapshot/resolver-inconsistent': '`snapshotResolver` is a Jest key',
  'snapshot/resolver-missing-member': '`snapshotResolver` is a Jest key',
  'snapshot/inline-prettier': 'the native formatter is `none`',
  'snapshot/inline-no-frame':
    "a package installed under `node_modules`, which the corpus's copy of a fixture has none of",
  'snapshot/inline-tsx': 'a Jest `preset` transform and a `.tsx` `testMatch`',
  'snapshot/inline-new-js':
    'writes the inline snapshot into the source: no native writer until Phase 7',
  'snapshot/inline-property-matchers':
    'writes the inline snapshot into the source: no native writer until Phase 7',
  'snapshot/inline-resolves':
    'writes the inline snapshot into the source: no native writer until Phase 7',
  'snapshot/inline-throw-error':
    'writes the inline snapshot into the source: no native writer until Phase 7',
  'snapshot/inline-two-on-one-line':
    'writes the inline snapshot into the source: no native writer until Phase 7',
  'snapshot/inline-update':
    'writes the inline snapshot into the source: no native writer until Phase 7',
  'snapshot/inline-same-call-twice':
    'one call that would write two values: Jest fails it while writing the source, and there is no native writer until Phase 7',
  'snapshot/obsolete-local':
    'an obsolete snapshot fails a local Jest run (`obsolete.failLocal`); the native slice keeps the neutral rule, which does not',
  'snapshot/inline-written':
    'writes the inline snapshot into the source: no native writer until Phase 7',
}

/** Pairs whose stored files the run must leave as they were, bytes and mtime, with why. */
const UNTOUCHED: Readonly<Record<string, string>> = {
  'snapshot/strings-24 (native)':
    'every string Jest stored matches, so the native run leaves its .snap alone, mtime included',
}

/** The pairs the check ran and the snapshot tests in them, pinned so it cannot pass by running nothing. */
const EXPECTED = { pairs: 53, evidenceOnly: 11, tests: 154, native: 20, nativeTests: 78 } as const

const fixtures: Fixture[] = await Promise.all(
  (await findFixtures(path.join(defaultFixturesRoot(), 'snapshot'))).map((dir) => readFixture(dir)),
)

const counted = { pairs: 0, evidenceOnly: 0, tests: 0, native: 0, nativeTests: 0 }
const declaredSeen = new Set<string>()
const nativeExcludedSeen = new Set<string>()
const untouchedSeen = new Set<string>()
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
    for (const profile of SNAPSHOT_PROFILES) {
      const native = profile === 'native'
      if (native && Object.hasOwn(NATIVE_EXCLUDED, fixture.id)) {
        nativeExcludedSeen.add(fixture.id)
        continue
      }
      if (!fixture.manifest.runners.includes(recordedRunner(profile))) continue
      const ran = runnableFiles(fixture, profile)
      if (ran.length === 0 || Object.hasOwn(HELD_BY_PROVINO_JEST, fixture.id)) {
        if (native) throw new Error(`${fixture.id}: list it in NATIVE_EXCLUDED, with why`)
        counted.evidenceOnly++
        continue
      }
      test(profile, { timeout: TIMEOUT_MS }, async () => {
        const signal = AbortSignal.timeout(TIMEOUT_MS - ABORT_MARGIN_MS)
        const golden = await readGolden(fixture.dir, recordedRunner(profile))
        const observed = golden.observed ?? {}
        const captured = Object.keys(observed.files ?? {})
        const result = await runSnapshotEndToEnd(fixture, profile, captured, signal)
        left.set(`${fixture.id} (${profile})`, result)
        if (native) counted.native++
        else counted.pairs++

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
        if (native) counted.nativeTests += wanted.size
        else counted.tests += wanted.size

        const files = comparedFiles(captured, ran)
        const pair = `${fixture.id} (${profile})`
        if (Object.hasOwn(DECLARED, pair)) {
          declaredSeen.add(pair)
          assert.equal(result.exitCode, 1, 'the exit code')
          assert.deepEqual([...got.values()], ['failed'], 'the test fails')
          const messages = result.normalized.files.flatMap((f) =>
            f.tests.flatMap((t) => t.errors.map((e) => e.message)),
          )
          assert.ok(
            messages.some((message) => message.includes('no inline snapshot writer')),
            `the failure says there is no writer: ${messages.join(' | ')}`,
          )
          for (const file of files) {
            const original = await readFile(path.join(fixture.dir, file), 'utf8')
            assert.equal(result.files[file], original, `${file} is left as it was`)
          }
          return
        }

        assert.deepEqual([...got], [...wanted], `tests (stderr: ${result.stderr.slice(0, 400)})`)
        if (ran.length === testFilesFor(fixture.files, recordedRunner(profile)).length) {
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
        if (Object.hasOwn(UNTOUCHED, pair)) {
          // The stored `.snap` Jest wrote is matched whole and never written again (B28).
          assert.deepEqual(result.touched, [], `${pair}: ${UNTOUCHED[pair]}`)
          untouchedSeen.add(pair)
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

  test('every UNTOUCHED pair ran and left its files alone', () => {
    assert.deepEqual([...untouchedSeen].sort(), Object.keys(UNTOUCHED).sort())
  })

  test('every NATIVE_EXCLUDED key is a fixture, and has a reason', () => {
    assert.deepEqual([...nativeExcludedSeen].sort(), Object.keys(NATIVE_EXCLUDED).sort())
    for (const [id, reason] of Object.entries(NATIVE_EXCLUDED)) assert.ok(reason.length > 0, id)
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
