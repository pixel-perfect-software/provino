// B25g, T11.16: `provino vitest` ends with the exit codes Vitest 5.0.5 ends with, against the
// black-box `cli/` goldens recorded from the real runner. The bin is a child process.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { keptLines, provinoVitest, withVitestFixture } from './vitest-recorded.ts'

const CASES: readonly { readonly name: string; readonly fixture: string }[] = [
  { name: 'a failing test', fixture: 'cli/vitest-exit-fail' },
  { name: 'a test file that declares no test', fixture: 'cli/vitest-exit-empty-file' },
  { name: 'a filter that matches no file', fixture: 'cli/vitest-exit-no-tests' },
  { name: 'a flag Vitest does not know', fixture: 'cli/unknown-flag' },
]

describe('provino vitest exit codes against Vitest 5.0.5', () => {
  for (const { name, fixture: id } of CASES) {
    it(`${name} (${id})`, async () => {
      await withVitestFixture(id, async (fixture, root) => {
        const expected = fixture.golden.observed
        assert.notEqual(expected?.exitCode, undefined, 'the golden records an exit code')
        const ended = await provinoVitest(fixture, root)
        assert.equal(ended.code, expected?.exitCode, ended.stderr)
        if (expected?.stderr !== undefined) {
          assert.equal(keptLines(fixture, ended.stderr), expected.stderr)
        }
      })
    })
  }
})
