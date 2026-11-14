// vscode-jest 6.4.4's requests, replayed (T11.12, D125): each `ide/vscode-jest-*` fixture runs the
// argv the editor's Jest process receives after the shell (`fixtures/ide/README.md` has the source
// lines) on the 7-test Spike A project, recorded from Jest 30.5.2. `provino jest` must give the
// same exit code, the same reporter control lines on stderr (`onRunStart`, `onTestFileResult`,
// `onRunComplete`, `Test results written to:`), the same results file with the colour codes kept,
// and the same `.snap`. The fields vscode-jest reads from the file are asserted by name besides, so
// a regression names the field. No editor runs: the replays are data (D125).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Json } from './mask.ts'
import { loadFixture } from './recorded.ts'
import { assertMatchesGolden, provinoOn, type RecordedRun } from './recorded-run.ts'

const OUT = '.harness-out/jest_runner_ws_0.json'
const REPORTER = 'vscode-jest-reporter.js'

/** Requests that write a results file (all but `list` and `debug`). */
const RESULT_REQUESTS = [
  'all',
  'file',
  'test',
  'pattern',
  'test-pattern',
  'update-snapshot',
  'dashed',
] as const

const ANSI = { test: (text: string): boolean => text.includes('\u001b[') }

interface Assertion {
  title: unknown
  fullName: unknown
  ancestorTitles: unknown
  status: unknown
  location: unknown
  failureMessages: unknown
}
interface FileResult {
  name: unknown
  status: unknown
  message: unknown
  assertionResults: Assertion[]
}
interface Results {
  testResults: FileResult[]
}

/** The fields vscode-jest reads (`test_reconciler.ts`, `TestResult.ts`), nothing else. */
function fieldsRead(results: Results): unknown[] {
  return results.testResults.map((file) => ({
    name: file.name,
    status: file.status,
    message: file.message,
    assertionResults: file.assertionResults.map((a) => ({
      title: a.title,
      fullName: a.fullName,
      ancestorTitles: a.ancestorTitles,
      status: a.status,
      location: a.location,
      failureMessages: a.failureMessages,
    })),
  }))
}

function asResults(value: Json | null | undefined, what: string): Results {
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    `${what}: no results file`,
  )
  return value as unknown as Results
}

async function replay(request: string): Promise<{ id: string; run: RecordedRun }> {
  const id = `ide/vscode-jest-${request}`
  return { id, run: await provinoOn(id) }
}

describe('vscode-jest replays (T11.12)', () => {
  it('every reporter copy is byte-equal to cli/reporters-twenty’s', async () => {
    const original = (await loadFixture('cli/reporters-twenty')).manifest.files?.jest?.[REPORTER]
    assert.equal(typeof original, 'string')
    for (const request of RESULT_REQUESTS) {
      const copy = (await loadFixture(`ide/vscode-jest-${request}`)).manifest.files?.jest?.[
        REPORTER
      ]
      assert.equal(copy, original, `ide/vscode-jest-${request}: ${REPORTER} differs`)
    }
  })

  it('list-test-files: --listTests --json prints one array line of paths', async () => {
    const { id, run } = await replay('list')
    assertMatchesGolden(id, run)
    assert.equal(run.code, 0)
    assert.equal(run.stdout, '<root>/sum.test.ts')
  })

  for (const request of RESULT_REQUESTS) {
    it(`${request}: the results file, control lines and exit code`, async () => {
      const { id, run } = await replay(request)
      assertMatchesGolden(id, run)

      const golden = (await loadFixture(id)).golden.observed?.json?.[OUT]
      const ours = asResults(run.json[OUT], id)
      const theirs = asResults(golden, `${id} golden`)

      // The fields by name, so a regression says which one moved.
      assert.equal(ours.testResults.length, theirs.testResults.length, `${id}: file count`)
      const read = fieldsRead(ours) as ReturnType<typeof fieldsRead>
      const want = fieldsRead(theirs)
      for (const [index, file] of ours.testResults.entries()) {
        const expected: FileResult | undefined = theirs.testResults[index]
        assert.ok(expected !== undefined)
        assert.equal(file.name, expected.name, `${id}: testResults[${index}].name`)
        assert.equal(file.status, expected.status, `${id}: testResults[${index}].status`)
        assert.equal(file.message, expected.message, `${id}: testResults[${index}].message`)
        assert.equal(
          file.assertionResults.length,
          expected.assertionResults.length,
          `${id}: assertionResults length`,
        )
        for (const [at, a] of file.assertionResults.entries()) {
          const b: Assertion | undefined = expected.assertionResults[at]
          assert.ok(b !== undefined)
          for (const key of [
            'title',
            'fullName',
            'ancestorTitles',
            'status',
            'location',
            'failureMessages',
          ] as const) {
            assert.deepEqual(a[key], b[key], `${id}: assertionResults[${at}].${key}`)
          }
        }
      }
      assert.deepEqual(read, want)

      // Under `--colors` the failing test's message and failureMessages carry colour codes, and
      // vscode-jest strips them itself (`TestResult.ts:116-137`).
      const failing = ours.testResults.flatMap((file) =>
        file.assertionResults.filter((a) => a.status === 'failed'),
      )
      for (const a of failing) {
        assert.ok(
          (a.failureMessages as string[]).every((text) => ANSI.test(text)),
          `${id}: failureMessages have no colour codes`,
        )
      }
      if (failing.length > 0) {
        assert.ok(ANSI.test(String(ours.testResults[0]?.message)), `${id}: message has no colour`)
      }

      // The reporter's control lines, as the extension matches them (`process-listeners.ts`).
      assert.match(run.stderr, /^onRunStart: numTotalTestSuites: 1\r$/m)
      assert.match(run.stderr, /^onRunComplete\r$/m)
      assert.match(run.stderr, /^Test results written to: \.harness-out\/jest_runner_ws_0\.json$/m)
    })
  }

  it('update-snapshot: the stored snapshot is rewritten', async () => {
    const { id, run } = await replay('update-snapshot')
    const text = run.files['__snapshots__/sum.test.ts.snap']
    assert.ok(
      typeof text === 'string' && text.includes('"stored"'),
      `${id}: the .snap is not updated`,
    )
  })

  it('debug: no --json, Jest’s own text, exit 1 for the failing test', async () => {
    const { id, run } = await replay('debug')
    assertMatchesGolden(id, run)
    assert.equal(run.code, 1)
    assert.match(run.stderr, /^Tests: {7}1 failed, 1 skipped, 1 todo, 4 passed, 7 total$/m)
  })
})
