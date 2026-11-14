// `provino jest --randomize --seed` (T5.13, B23d): the order the tests run in, and what the run
// prints, against what Jest 30.5.2 did with the same files and seed (`cli/randomize-*`,
// `cli/seed-*`). The order is read from the results file (`assertionResults` are in run order) and,
// for `randomize-seed-30`, from the verbose lines (the tree grows in the order tests first report).
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { Json } from './mask.ts'
import { loadFixture, materialize } from './recorded.ts'
import { spawnCli } from './support.ts'

const RESULTS = '.harness-out/jest.json'

interface Assertion {
  readonly title: string
  readonly status: string
  readonly ancestorTitles: readonly string[]
}

/** The tests of a Jest results file in the order they are listed, as `ancestors > title: status`. */
function order(results: Json | null | undefined, where: string): string[] {
  assert.ok(results !== null && results !== undefined, `${where}: no results file`)
  const files = (results as unknown as { testResults: { assertionResults: Assertion[] }[] })
    .testResults
  assert.equal(files.length, 1, `${where}: one test file`)
  return (files[0]?.assertionResults ?? []).map(
    (test) => `${[...test.ancestorTitles, test.title].join(' > ')}: ${test.status}`,
  )
}

/** Verbose lines with each duration taken out, as the recording's lines are. */
function keptLines(stderr: string, keepLines: string): string[] {
  const keep = new RegExp(keepLines)
  return stderr
    .split('\n')
    .filter((line) => keep.test(line))
    .map((line) => line.replace(/ \((?:<dur>|\d+(?:\.\d+)? ms)\)$/, ''))
}

async function provinoOn(id: string) {
  const fixture = await loadFixture(id)
  const project = await materialize(fixture)
  try {
    await mkdir(join(project.root, '.harness-out'), { recursive: true })
    const argv = fixture.manifest.run?.argv?.jest ?? []
    const ended = await spawnCli(
      [
        'jest',
        `--config=${join(project.root, 'jest.config.json')}`,
        '--ci',
        ...argv,
        '--json',
        `--outputFile=${RESULTS}`,
      ],
      { cwd: project.root },
    )
    let results: Json | null = null
    try {
      results = JSON.parse(await readFile(join(project.root, RESULTS), 'utf8')) as Json
    } catch {
      // A run that ends before it writes results (a bad seed).
    }
    const golden = fixture.golden.observed
    return {
      code: ended.code,
      stderr: ended.stderr,
      ours: results === null ? null : order(results, `${id} (Provino)`),
      recorded: golden?.json?.[RESULTS] === undefined ? null : order(golden.json[RESULTS], id),
      recordedCode: golden?.exitCode,
      recordedStderr: golden?.stderr ?? '',
      keepLines: fixture.manifest.run?.keepLines,
    }
  } finally {
    await project.dispose()
  }
}

describe('provino jest --randomize runs the tests in the order Jest 30.5.2 did', () => {
  for (const [id, what] of [
    ['cli/randomize-seed-flat', '30 top-level tests with --seed=1234'],
    ['cli/randomize-seed-30', 'blocks, nesting, each, concurrent, skip and todo with --seed=1234'],
    ['cli/randomize-seed-negative', '--seed=-7'],
    ['cli/seed-without-randomize', '--seed=42 without --randomize: declared order, getSeed() read'],
  ] as const) {
    it(`${what} (${id})`, async () => {
      const run = await provinoOn(id)
      assert.equal(run.code, run.recordedCode, run.stderr)
      assert.ok(run.recorded !== null && run.recorded.length > 0, 'the recording has tests')
      assert.deepEqual(run.ours, run.recorded, run.stderr)
    })
  }

  it('prints the verbose tree in the shuffled order (cli/randomize-seed-30)', async () => {
    const run = await provinoOn('cli/randomize-seed-30')
    assert.ok(run.keepLines !== undefined)
    const expected = keptLines(run.recordedStderr, run.keepLines)
    assert.ok(expected.length > 30, 'the recording kept the tree')
    assert.deepEqual(keptLines(run.stderr, run.keepLines), expected, run.stderr)
  })

  it('gives the same order for the same seed and another for another (cli/randomize-seed-flat)', async () => {
    const first = await provinoOn('cli/randomize-seed-flat')
    const fixture = await loadFixture('cli/randomize-seed-flat')
    const project = await materialize(fixture)
    try {
      await mkdir(join(project.root, '.harness-out'), { recursive: true })
      await spawnCli(
        [
          'jest',
          `--config=${join(project.root, 'jest.config.json')}`,
          '--ci',
          '--randomize',
          '--seed=1235',
          '--json',
          `--outputFile=${RESULTS}`,
        ],
        { cwd: project.root },
      )
      const other = order(
        JSON.parse(await readFile(join(project.root, RESULTS), 'utf8')) as Json,
        'seed 1235',
      )
      assert.notDeepEqual(other, first.ours)
      assert.deepEqual([...other].sort(), [...(first.ours ?? [])].sort())
    } finally {
      await project.dispose()
    }
  })

  it('refuses a seed out of range with Jest’s validation error and runs nothing (cli/seed-out-of-range)', async () => {
    const run = await provinoOn('cli/seed-out-of-range')
    assert.equal(run.code, run.recordedCode, run.stderr)
    assert.ok(run.keepLines !== undefined)
    // The recorder writes a hexadecimal number as `<addr>`.
    const ours = keptLines(run.stderr, run.keepLines).map((line) =>
      line.replace(/0x[0-9a-f]+/gi, '<addr>'),
    )
    assert.deepEqual(ours, keptLines(run.recordedStderr, run.keepLines), run.stderr)
    assert.equal(run.ours, null, 'no results are written')
  })
})
