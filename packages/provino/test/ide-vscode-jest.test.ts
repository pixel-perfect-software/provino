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
import { playPiped, RESULTS_WRITTEN, watcherSkip } from './watch-goldens.ts'

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
  'related',
  'coverage',
] as const

/** The watch requests: `--watch` and `--watchAll` (JestProcess.ts:31-39), on a pipe. */
const WATCH_REQUESTS = ['watch', 'watch-all'] as const

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[`)

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

function asResults(value: Json | null | undefined, what: string): Results {
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    `${what}: no results file`,
  )
  return value as unknown as Results
}

/** The fields vscode-jest reads from a results file, by name, so a regression says which moved. */
function assertFields(id: string, ours: Results, theirs: Results): void {
  assert.equal(ours.testResults.length, theirs.testResults.length, `${id}: file count`)
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
}

describe('assertFields', () => {
  const file = (status: string): Results => ({
    testResults: [
      {
        name: 'a',
        status: 'passed',
        message: '',
        assertionResults: [
          {
            title: 't',
            fullName: 't',
            ancestorTitles: [],
            status,
            location: null,
            failureMessages: [],
          },
        ],
      },
    ],
  })

  it('names the field of the replay that differs from the golden’s', () => {
    assertFields('x', file('passed'), file('passed'))
    assert.throws(
      () => assertFields('x', file('failed'), file('passed')),
      /assertionResults\[0\]\.status/,
    )
  })
})

/** Each request is replayed once, whichever tests read it. */
const replays = new Map<string, Promise<{ id: string; run: RecordedRun }>>()

function replay(request: string): Promise<{ id: string; run: RecordedRun }> {
  let played = replays.get(request)
  if (played === undefined) {
    const id = `ide/vscode-jest-${request}`
    played = provinoOn(id).then((run) => ({ id, run }))
    replays.set(request, played)
  }
  return played
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

      const golden = run.fixture.golden.observed?.json?.[OUT]
      const ours = asResults(run.json[OUT], id)
      const theirs = asResults(golden, `${id} golden`)

      assertFields(id, ours, theirs)

      // Under `--colors` the failing test's message and failureMessages carry colour codes, and
      // vscode-jest strips them itself (`TestResult.ts:116-137`).
      const failing = ours.testResults.flatMap((file) =>
        file.assertionResults.filter((a) => a.status === 'failed'),
      )
      for (const a of failing) {
        const messages = a.failureMessages as string[]
        assert.ok(messages.length > 0, `${id}: a failed assertion has no failureMessages`)
        for (const text of messages) {
          assert.match(text, ANSI, `${id}: a failure message has no colour codes`)
        }
      }
      for (const file of ours.testResults.filter((f) => f.status === 'failed')) {
        assert.match(
          String(file.message),
          ANSI,
          `${id}: ${String(file.name)} message has no colour`,
        )
      }

      // The reporter's control lines, as the extension matches them (`process-listeners.ts`).
      assert.match(run.stderr, /^onRunStart: numTotalTestSuites: 1\r$/m)
      assert.match(run.stderr, /^onRunComplete\r$/m)
      assert.match(run.stderr, /^Test results written to: \.harness-out\/jest_runner_ws_0\.json$/m)
    })
  }

  it('related: --findRelatedTests runs only the test that reaches the file', async () => {
    const { id, run } = await replay('related')
    const ours = asResults(run.json[OUT], id)
    assert.deepEqual(
      ours.testResults.map((file) => String(file.name).replace(/^.*\//, '')),
      ['sum.test.ts'],
      `${id}: other.test.ts is not related to src/sum.ts`,
    )
    assert.equal(run.code, 0)
  })

  it('coverage: --coverage adds coverageMap to the results file and the table to stdout', async () => {
    const { id, run } = await replay('coverage')
    const results = asResults(run.json[OUT], id) as unknown as { coverageMap?: object }
    assert.deepEqual(Object.keys(results.coverageMap ?? {}).length, 1, `${id}: coverageMap files`)
    assert.match(run.stdout, /All files/)
    assert.match(run.stdout, /sum\.ts/)
  })

  it('update-snapshot: the stored snapshot is rewritten', async () => {
    const { id, run } = await replay('update-snapshot')
    const text = run.files['__snapshots__/sum.test.ts.snap']
    assert.ok(
      typeof text === 'string' && text.includes('"stored"'),
      `${id}: the .snap is not updated`,
    )
    assert.ok(!text.includes('"old"'), `${id}: the stale snapshot is still in the .snap`)
  })

  it('debug: no --json, Jest’s own text, exit 1 for the failing test', async () => {
    const { id, run } = await replay('debug')
    assertMatchesGolden(id, run)
    assert.equal(run.code, 1)
    assert.match(run.stderr, /^Tests: {7}1 failed, 1 skipped, 1 todo, 4 passed, 7 total$/m)
  })
})

/**
 * The watch requests, on a pipe in a process group of their own (`playPiped`): the bin is killed
 * and its group probed whatever happens. A sandbox without file events skips them, saying why,
 * and with `CI` set that is an error; CI's Linux legs run them. The results file is read after
 * each run, as vscode-jest reads it on `Test results written to`, and compared with the golden's
 * (the session has no exit code: a piped Jest has no key to quit with, and the editor kills it).
 */
describe('vscode-jest watch replays (T11.12, B23e Phase 4)', () => {
  for (const request of WATCH_REQUESTS) {
    it(`${request}: the run log, the results file after each run and the reporter lines`, {
      timeout: 150_000,
    }, async (t) => {
      const skip = await watcherSkip()
      if (skip !== false) return t.skip(skip)
      const id = `ide/vscode-jest-${request}`
      // `playPiped` holds the run log, the kept reporter lines and each captured results file to
      // the golden's (the same keys, one per run); `assertFields` names the field of a results
      // file that moved, ahead of the whole-file comparison.
      const played = await playPiped(await loadFixture(id), {
        compareCapture: (key, ours, theirs) => {
          const results = asResults(ours, `${id} replay ${key}`)
          assert.ok(results.testResults.length > 0, `${key}: no test file`)
          assertFields(key, results, asResults(theirs, `${id} golden ${key}`))
        },
      })
      assert.equal(Object.keys(played.json ?? {}).length, 2, `${id}: two runs`)
      const lines = (played.transcript ?? '').split('\n')
      assert.equal(lines.filter((line) => line === 'onRunComplete').length, 2)
      assert.equal(lines.filter((line) => line.startsWith(RESULTS_WRITTEN)).length, 2)
    })
  }
})
