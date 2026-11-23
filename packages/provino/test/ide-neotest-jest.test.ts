// neotest-jest's command lines (neotest-jest 0e7979d, `lua/neotest-jest/init.lua` and
// `parameterized-tests.lua`; `packages/harness/fixtures/ide/README.md` has each argv with its
// source lines) run through `provino jest` and held to the golden recorded from Jest 30.5.2 on the
// same project: the results file, the kept stderr lines, the exit code. Then the fields neotest
// reads back are asserted by name, so a change to one of them says which.
import assert from 'node:assert/strict'
import { describe, it } from 'provino'
import type { Json } from './mask.ts'
import { assertMatchesGolden, provinoOn, type RecordedRun } from './recorded-run.ts'

const RUN_FILE = '.harness-out/neotest.json'
// `.each` discovery has no `--outputFile`: neotest reads Jest's JSON from stdout.
const DISCOVERY = 'stdout'

interface Assertion {
  readonly status: string
  readonly title: string
  readonly ancestorTitles: readonly string[]
  readonly location: { readonly line: number; readonly column: number } | null
  readonly failureMessages: readonly string[]
}

interface Results {
  readonly testResults: readonly { readonly name: string; readonly assertionResults: Assertion[] }[]
}

/** The golden's and Provino's results, as neotest reads them (`testResults[].assertionResults[]`). */
function results(json: Json | null, what: string): Results {
  assert.ok(json !== null && typeof json === 'object' && !Array.isArray(json), `${what}: no JSON`)
  return json as unknown as Results
}

/** neotest's position id for an assertion (`jest-util.lua:168-179`): the title path after the file. */
function id(assertion: Assertion): string {
  return [...assertion.ancestorTitles, assertion.title].join('::')
}

async function replay(fixture: string, file: string) {
  const run: RecordedRun = await provinoOn(`ide/${fixture}`)
  assertMatchesGolden(`ide/${fixture}`, run)
  const mine = results(run.rawJson(file), fixture)
  const golden = run.fixture.golden.observed?.json?.[file]
  assert.ok(golden !== undefined, `${fixture}: the golden has no json:${file}`)
  return { run, mine, golden: results(golden as Json, fixture) }
}

/** Each assertion's fields neotest reads, by position id, in the file's order. */
function fields(parsed: Results): Record<string, unknown>[] {
  return parsed.testResults.flatMap((file) =>
    file.assertionResults.map((a) => ({
      file: file.name.slice(file.name.lastIndexOf('/') + 1),
      id: id(a),
      status: a.status,
      title: a.title,
      ancestorTitles: a.ancestorTitles,
      location: a.location,
      failureCount: a.failureMessages.length,
    })),
  )
}

describe('neotest-jest: run', () => {
  it('a file (testNamePattern .*): every test, a failure with its location', async () => {
    const { run, mine, golden } = await replay('neotest-jest-file', RUN_FILE)
    assert.equal(run.code, 1, 'a failing test ends the run with 1')
    assert.deepEqual(fields(mine), fields(golden))
    const byId = new Map(mine.testResults.flatMap((f) => f.assertionResults).map((a) => [id(a), a]))
    assert.equal(byId.get('sum::adds')?.status, 'passed')
    const failed = byId.get('sum::fails')
    assert.equal(failed?.status, 'failed')
    assert.equal(failed?.failureMessages.length, 1, 'neotest reads failureMessages[0]')
    assert.match(failed?.failureMessages[0] ?? '', /Expected: 3/)
    assert.deepEqual(
      failed?.location,
      { line: 7, column: 3 },
      'location is 1-based, as neotest uses it',
    )
    // neotest turns `pending` and `todo` into `skipped`.
    assert.equal(byId.get('sum::is skipped')?.status, 'pending')
    assert.equal(byId.get('sum::is todo')?.status, 'todo')
    assert.deepEqual(byId.get('sum::nested::deeper::goes deep')?.ancestorTitles, [
      'sum',
      'nested',
      'deeper',
    ])
    assert.match(run.stderr, /Force exiting Jest/)
  })

  it('a test (^…$ with escaped parentheses and dash): only that test runs', async () => {
    const { run, mine, golden } = await replay('neotest-jest-test', RUN_FILE)
    assert.equal(run.code, 0)
    assert.deepEqual(fields(mine), fields(golden))
    const ran = mine.testResults
      .flatMap((f) => f.assertionResults)
      .filter((a) => a.status !== 'pending')
    assert.deepEqual(
      ran.map((a) => [id(a), a.status]),
      [['sum::nested::handles (parens) and a-dash', 'passed']],
    )
  })

  it('a nested describe (^sum nested, no $): the describe runs, the rest is pending', async () => {
    const { run, mine, golden } = await replay('neotest-jest-describe', RUN_FILE)
    assert.equal(run.code, 1)
    assert.deepEqual(fields(mine), fields(golden))
    const ran = mine.testResults
      .flatMap((f) => f.assertionResults)
      .filter((a) => a.status !== 'pending')
      .map((a) => [id(a), a.status])
    assert.deepEqual(ran, [
      ['sum::nested::handles (parens) and a-dash', 'passed'],
      ['sum::nested::fails inside', 'failed'],
      ['sum::nested::deeper::goes deep', 'passed'],
    ])
  })
})

describe('neotest-jest: .each discovery', () => {
  it('every test is pending with its location, read from stdout', async () => {
    const { run, mine, golden } = await replay('neotest-jest-each-discovery', DISCOVERY)
    assert.equal(run.code, 0)
    assert.deepEqual(fields(mine), fields(golden))
    const all = mine.testResults.flatMap((f) => f.assertionResults)
    assert.ok(all.length > 0)
    for (const assertion of all) {
      assert.equal(assertion.status, 'pending', `${id(assertion)} is pending`)
      assert.ok(assertion.location !== null, `${id(assertion)} has a location`)
    }
    // Each `.each` row has its own title and the same location (the call's).
    const rows = all.filter((a) => a.title.startsWith('each '))
    assert.deepEqual(
      rows.map((a) => a.title),
      ['each 1', 'each 3'],
    )
    assert.deepEqual(rows[0]?.location, rows[1]?.location)
    const groups = all.filter((a) => a.title === 'has a number')
    assert.deepEqual(
      groups.map((a) => a.ancestorTitles),
      [
        ['sum', 'group 1'],
        ['sum', 'group 2'],
      ],
    )
  })
})
