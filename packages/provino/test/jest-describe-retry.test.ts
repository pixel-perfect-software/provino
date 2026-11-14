// `jest.retryTimes(n, { entireDescribe: true })` as Jest's reporters see it (T5.10, B23d): a custom
// reporter's `onTestCaseStart` and `onTestCaseResult` calls, and the results file, against what
// Jest 30.5.2 gave on the same project (`cli/retry-entire-describe-reporter`). circus reports every
// `test_done`, so a dropped describe attempt is a result too, each test with its own status and
// passing assertions; the final result carries the counts of the attempt that stood.
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { Json } from './mask.ts'
import { loadFixture, materialize } from './recorded.ts'
import { spawnCli } from './support.ts'

const ID = 'cli/retry-entire-describe-reporter'
const RESULTS = '.harness-out/jest.json'

interface Assertion {
  readonly fullName: string
  readonly status: string
  readonly invocations?: number
  readonly numPassingAsserts?: number
  readonly failureMessages: readonly string[]
}

/** Each test of the one file in a results file, as `name status invocations passing failures`. */
function assertions(results: Json | null | undefined, where: string): string[] {
  assert.ok(results !== null && results !== undefined, `${where}: no results file`)
  const files = (results as unknown as { testResults: { assertionResults: Assertion[] }[] })
    .testResults
  assert.equal(files.length, 1, `${where}: one test file`)
  return (files[0]?.assertionResults ?? []).map(
    (test) =>
      `${test.fullName} ${test.status} invocations=${test.invocations} numPassingAsserts=${test.numPassingAsserts} failures=${test.failureMessages.length}`,
  )
}

describe('provino jest reports a describe-level retry as Jest 30.5.2 did', () => {
  it(`calls onTestCaseResult once per describe attempt, and the results hold the last attempt (${ID})`, async () => {
    const fixture = await loadFixture(ID)
    const project = await materialize(fixture)
    try {
      await mkdir(join(project.root, '.harness-out'), { recursive: true })
      const ended = await spawnCli(
        [
          'jest',
          `--config=${join(project.root, 'jest.config.json')}`,
          '--ci',
          '--json',
          `--outputFile=${RESULTS}`,
        ],
        { cwd: project.root },
      )
      const golden = fixture.golden.observed
      assert.equal(ended.code, golden?.exitCode, ended.stderr)
      const calls = await readFile(join(project.root, 'calls.txt'), 'utf8')
      const recorded = golden?.files?.['calls.txt']
      assert.ok(typeof recorded === 'string' && recorded.length > 0, 'the recording has calls')
      assert.equal(calls, recorded, ended.stderr)
      const ours = JSON.parse(await readFile(join(project.root, RESULTS), 'utf8')) as Json
      assert.deepEqual(
        assertions(ours, 'Provino'),
        assertions(golden?.json?.[RESULTS], ID),
        ended.stderr,
      )
    } finally {
      await project.dispose()
    }
  })
})
