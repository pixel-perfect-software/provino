// `provino jest --json --outputFile` (T11.8): the results file as Jest 30.5.2 wrote it for the same
// project (`cli/json-*`: the recorder's `json:` capture, with times as `<time>`, the project's
// path as `<root>` and each run of stack frames as `<frames>`), the line Jest prints about it, the
// exit code, and what a `testResultsProcessor` receives and returns.
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { type Json, normalizedJson } from './mask.ts'
import { loadFixture, materialize } from './recorded.ts'
import { spawnCli } from './support.ts'

const RESULTS = '.harness-out/jest.json'

interface JsonResults {
  testResults: { name: string; assertionResults: { failureMessages: string[]; status: string }[] }[]
}

/** The run's files in a fixed order (Jest lists them in the order they finished). */
function sorted(value: Json): Json {
  const results = value as { testResults?: { name: string }[] }
  if (results.testResults === undefined) return value
  return {
    ...(value as object),
    testResults: results.testResults.toSorted((a, b) => a.name.localeCompare(b.name)),
  } as Json
}

async function provinoOn(id: string): Promise<{
  readonly code: number | null
  readonly stderr: string
  readonly raw: Json
  readonly recorded: Json
  readonly recordedStderr: string | undefined
  readonly recordedCode: number | null | undefined
  readonly keys: string | null | undefined
  readonly processorKeys: string | null | undefined
}> {
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
    const raw = JSON.parse(await readFile(join(project.root, RESULTS), 'utf8')) as Json
    const run = fixture.manifest.run
    const normalized = normalizedJson(raw, {
      roots: [project.root],
      timeKeys: run?.timeKeys ?? [],
      mask: run?.mask,
    })
    const golden = fixture.golden.observed
    const keepLines = new RegExp(run?.keepLines ?? '.')
    const processorKeys = golden?.files?.['processor-keys.txt']
    return {
      code: ended.code,
      stderr: ended.stderr
        .split('\n')
        .filter((line) => keepLines.test(line))
        .join('\n'),
      raw,
      recorded: sorted(golden?.json?.[RESULTS] ?? null),
      recordedStderr: golden?.stderr,
      recordedCode: golden?.exitCode,
      keys: normalized === null ? null : JSON.stringify(sorted(normalized)),
      processorKeys:
        processorKeys === undefined
          ? undefined
          : await readFile(join(project.root, 'processor-keys.txt'), 'utf8'),
    }
  } finally {
    await project.dispose()
  }
}

describe('provino jest --json writes what Jest 30.5.2 wrote', () => {
  for (const [id, what] of [
    ['cli/json-vscode-contract', 'the contract vscode-jest reads: statuses, locations, snapshot'],
    ['cli/json-no-location', '--testLocationInResults=false: every location is null'],
    ['cli/json-file-states', 'a file that fails to import, an all-skipped file and a focused one'],
    ['cli/json-results-processor', 'a testResultsProcessor: its keys in, its return out'],
  ] as const) {
    it(`${what} (${id})`, async () => {
      const run = await provinoOn(id)
      assert.equal(run.code, run.recordedCode, run.stderr)
      assert.equal(run.stderr, run.recordedStderr)
      const files = (run.recorded as unknown as JsonResults).testResults
      assert.ok(files.length > 0, 'the recording has files')
      assert.deepEqual(JSON.parse(run.keys ?? 'null'), run.recorded)
      if (run.processorKeys !== undefined) {
        const golden = (await loadFixture(id)).golden.observed?.files?.['processor-keys.txt']
        assert.equal(run.processorKeys, golden)
      }
      const results = run.raw as unknown as JsonResults
      for (const file of results.testResults) {
        for (const test of file.assertionResults) {
          assert.ok(['passed', 'failed', 'pending', 'todo'].includes(test.status), test.status)
          for (const message of test.failureMessages) {
            assert.match(message, /\.test\.ts:\d+:\d+/, 'a failure names where it happened')
          }
        }
      }
    })
  }
})

describe('provino jest --json with no output file', () => {
  it('prints the JSON on stdout, even when no test file was found (--passWithNoTests)', async () => {
    const project = await materialize({
      id: 'inline',
      dir: join(import.meta.dirname, 'fixtures'),
      manifest: { description: 'no tests', config: { jest: { testMatch: ['<rootDir>/none/**/*.test.ts'] } } },
      golden: { files: [] },
    })
    try {
      const ended = await spawnCli(
        ['jest', `--config=${join(project.root, 'jest.config.json')}`, '--ci', '--json', '--passWithNoTests'],
        { cwd: project.root },
      )
      assert.equal(ended.code, 0, ended.stderr)
      const results = JSON.parse(ended.stdout) as { numTotalTests: number; success: boolean; testResults: unknown[] }
      assert.deepEqual([results.numTotalTests, results.success, results.testResults], [0, true, []])
    } finally {
      await project.dispose()
    }
  })
})
