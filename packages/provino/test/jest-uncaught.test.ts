// An error the code never handles, raised while a file runs, is charged as Jest 30.5.2 charges it.
// `cli/uncaught-during-test` records one file per timing: a timer that throws while its test runs,
// after its test ended (while the next test runs, during a later describe's `beforeAll`, during the
// file's `afterAll`), a rejection nobody handles while its test runs and one made after it ended,
// and a timer no test owns. jest-circus keeps each error in its owner's `test.errors` (the test whose
// async context raised it, even an ended one) and reads them when the run ends, so the owner is a
// failed test in the results and the file fails; an error no test owns fails the file as `Test
// suite failed to run`. `provino jest` must print the same and write the same results file.
//
// What the last test leaves after the run is over has no recording: Jest 30.5.2 in band exits with
// Node's own report of the error (its handlers are gone by then), and a worker dies. Provino keeps
// that outcome, a failed run, and says which test it was where it still can.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { assertMatchesGolden, provinoOn } from './recorded-run.ts'
import { spawnCli } from './support.ts'

const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('provino jest charges an unhandled error to its owner as Jest 30.5.2 does', () => {
  it('cli/uncaught-during-test: the exit code, the failure blocks and the results file', async () => {
    const run = await provinoOn('cli/uncaught-during-test')
    assertMatchesGolden('cli/uncaught-during-test', run)
  })

  it('cli/hooks-only-describe: each hook of a describe with no tests is the file’s error, with no class name', async () => {
    const run = await provinoOn('cli/hooks-only-describe')
    assertMatchesGolden('cli/hooks-only-describe', run)
  })
})

/** `provino jest --ci --json` over one test file, in band (one file). */
async function runOne(source: string): Promise<{
  readonly code: number | null
  readonly stderr: string
  readonly results: { readonly success: boolean; readonly numFailedTests: number }
}> {
  const dir = await mkdtemp(join(tmpdir(), 'provino-uncaught-'))
  made.push(dir)
  await writeFile(join(dir, 'package.json'), '{"name":"uncaught","type":"commonjs"}\n')
  await writeFile(join(dir, 'jest.config.json'), '{}\n')
  await writeFile(join(dir, 'last.test.js'), source)
  const ended = await spawnCli(['jest', '--ci', '--json', '--outputFile', 'results.json'], {
    cwd: dir,
  })
  const results = JSON.parse(await readFile(join(dir, 'results.json'), 'utf8')) as {
    success: boolean
    numFailedTests: number
  }
  return { code: ended.code, stderr: ended.stderr, results }
}

describe('what the last test leaves when the run is over still fails the run', () => {
  it('a rejection it left, reported in the file’s last turn, fails that test and its file', async () => {
    const run = await runOne(
      "test('leaves a rejection', () => {\n  void Promise.reject(new Error('left behind'))\n})\n",
    )
    assert.equal(run.code, 1, run.stderr)
    assert.match(run.stderr, /^FAIL \.\/last\.test\.js$/m)
    assert.match(run.stderr, /● leaves a rejection\n\n {4}left behind/)
    assert.doesNotMatch(run.stderr, /Unhandled error/, 'shown once, under its test')
    assert.equal(run.results.success, false)
    assert.equal(run.results.numFailedTests, 1)
  })

  it('a timer of it that throws once the file is over fails the run, with the error', async () => {
    const run = await runOne(
      "test('schedules a timer', () => {\n  setTimeout(() => {\n    throw new Error('after the file')\n  }, 0)\n})\n",
    )
    assert.equal(run.code, 1, run.stderr)
    assert.match(run.stderr, /after the file/)
    assert.equal(run.results.success, false)
  })
})
