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
import path from 'node:path'
import { describe, test } from 'node:test'
import { expectCorpusProblems } from './expect-corpus/compare.ts'
import { defaultFixturesRoot, findFixtures, readFixture } from './fixture.ts'
import { corePolicyFor } from './runtime-corpus/profiles.ts'

const root = path.join(defaultFixturesRoot(), 'expect', 'messages')
const dirs = await findFixtures(root)
const fixtures = await Promise.all(dirs.map((dir) => readFixture(dir)))

test('the message corpus is there', () => {
  assert.ok(dirs.length >= 10, `expected the B08 corpus under ${root}, found ${dirs.length}`)
})

for (const fixture of fixtures) {
  describe(fixture.id, () => {
    test('jest', async () => {
      const problems = await expectCorpusProblems(fixture, corePolicyFor.jest)
      assert.deepEqual(problems, [], `${problems.length} tests differ`)
    })
  })
}
