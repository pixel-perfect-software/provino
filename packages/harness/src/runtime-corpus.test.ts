// B07's corpus check (T5.3, T5.6): every runtime-corpus fixture, run through `@provino/core` under
// the policy of each profile it was recorded with, must give the golden's trace, the golden's
// tests (title path, `dupIndex`, status, location) and the golden's file status. Brief 7's
// "collected trees equal the recorded trees" and "every hook-order and failure scenario matches
// under jest, vitest-stack and vitest-list".
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { defaultFixturesRoot, findFixtures, readFixture, testFilesFor } from './fixture.ts'
import { corePolicyFor } from './runtime-corpus/profiles.ts'
import { runUnderCore } from './runtime-corpus/run-core.ts'

interface GoldenTest {
  readonly id: { readonly path: readonly string[]; readonly dupIndex: number }
  readonly status: string
  readonly location?: { readonly line: number; readonly column: number }
}

interface GoldenFile {
  readonly file: string
  readonly status: string
  readonly tests: readonly GoldenTest[]
}

interface GoldenShape {
  readonly files: readonly GoldenFile[]
  readonly trace?: readonly string[]
}

const root = path.join(defaultFixturesRoot(), 'runtime')
const dirs = await findFixtures(root)

test('the runtime corpus is there', () => {
  assert.ok(dirs.length >= 20, `expected the B07 corpus under ${root}, found ${dirs.length}`)
})

for (const dir of dirs) {
  const fixture = await readFixture(dir)
  describe(fixture.id, () => {
    for (const profile of fixture.manifest.runners) {
      test(profile, async () => {
        const goldenPath = path.join(fixture.dir, '__goldens__', `${profile}.json`)
        const golden = JSON.parse(await readFile(goldenPath, 'utf8')) as GoldenShape
        const [file] = testFilesFor(fixture.files, profile)
        const [goldenFile] = golden.files
        assert.ok(file !== undefined && goldenFile !== undefined, 'one test file per profile')
        const run = await runUnderCore(
          path.join(fixture.dir, file),
          fixture.dir,
          corePolicyFor[profile],
        )
        assert.deepEqual(run.trace, golden.trace ?? [], 'trace')
        assert.deepEqual(
          run.tests.map((t) => ({ path: t.path, dupIndex: t.dupIndex, status: t.status })),
          goldenFile.tests.map((t) => ({
            path: t.id.path,
            dupIndex: t.id.dupIndex,
            status: t.status,
          })),
          'tests: title path, dupIndex and status',
        )
        // Locations (line and column) where the golden has one: Jest's JSON drops the location of
        // a test that timed out (`timeouts`), which says nothing about where the test is.
        assert.deepEqual(
          run.tests.map((t, index) =>
            goldenFile.tests[index]?.location === undefined ? null : t.location,
          ),
          goldenFile.tests.map((t) => t.location ?? null),
          'test locations',
        )
        assert.equal(run.fileStatus, goldenFile.status, 'file status')
      })
    }
  })
}
