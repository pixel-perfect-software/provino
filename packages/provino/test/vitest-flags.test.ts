// B25g (D183): the Vitest flags `provino vitest` applies, each held to a `cli/vitest-*` golden
// recorded from Vitest 5.0.5. The bin is a child process.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { provinoVitest, reportedFiles, withVitestFixture } from './vitest-recorded.ts'

const OUTPUT = '.harness-out/provino.json'
const JSON_REPORT = ['--reporter=json', `--outputFile=${OUTPUT}`]

describe('provino vitest flags against Vitest 5.0.5', () => {
  it('--exclude adds to the config excludes (cli/vitest-exclude-additive)', () =>
    withVitestFixture('cli/vitest-exclude-additive', async (fixture, root) => {
      const ended = await provinoVitest(fixture, root, JSON_REPORT)
      assert.equal(ended.code, fixture.golden.observed?.exitCode, ended.stderr.slice(0, 500))
      assert.deepEqual(
        await reportedFiles(root, OUTPUT),
        fixture.golden.files?.map(({ file, status }) => ({ file, status })),
      )
    }))
})
