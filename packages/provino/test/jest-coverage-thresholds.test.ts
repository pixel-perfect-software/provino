// T8.11 through the bin: `provino jest` with `coverageThreshold`, against what real Jest 30.5.2
// printed for the same project (`coverage/threshold-*`): the `Jest: ...` lines on stderr in Jest's
// order and words (a glob group names each file, `<root>` the work directory), and the exit code.
// `--json`'s `success` is false for a missed threshold, as Jest's reporter error makes it.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { type Json, observedText } from './mask.ts'
import { loadFixture, materialize } from './recorded.ts'
import { spawnCli } from './support.ts'

/** The recorder's environment: no colour, so the failure lines carry no escape codes. */
const RECORDER_ENV = { CI: '1', NO_COLOR: '1', COLUMNS: '', GITHUB_ACTIONS: '' }

const disposers: (() => Promise<void>)[] = []
after(async () => {
  await Promise.all(disposers.map((dispose) => dispose()))
})

async function provinoOn(id: string, extra: readonly string[] = []) {
  const fixture = await loadFixture(id)
  const project = await materialize(fixture)
  disposers.push(project.dispose)
  const { root } = project
  await mkdir(join(root, '.harness-out'), { recursive: true })
  const outputFile = join(root, '.harness-out', 'jest.json')
  const ended = await spawnCli(
    [
      'jest',
      `--config=${join(root, 'jest.config.json')}`,
      '--ci',
      '--json',
      `--outputFile=${outputFile}`,
      ...(fixture.manifest.run?.argv?.jest ?? []),
      ...extra,
    ],
    { cwd: root, env: RECORDER_ENV },
  )
  const lines = observedText(ended.stderr, { roots: [root] })
    .split('\n')
    .filter((line) => line.startsWith('Jest: '))
    .join('\n')
  // Jest writes no results file when it found no test file; `success` is then unread.
  const json = existsSync(outputFile)
    ? (JSON.parse(await readFile(outputFile, 'utf8')) as Record<string, Json>)
    : undefined
  return {
    fixture,
    root,
    code: ended.code,
    lines,
    success: json?.success,
    stdout: ended.stdout,
    stderr: ended.stderr,
  }
}

describe('provino jest --coverage checks coverageThreshold as Jest 30.5.2 does (coverage/threshold-*)', () => {
  for (const [id, what] of [
    ['threshold-global', 'every metric under a global threshold, in Jest metric order'],
    ['threshold-path-glob', 'a path group on its total, a glob group file by file, and global'],
    [
      'threshold-overlap',
      'a file two groups name counts for each: the glob group reports its miss',
    ],
    ['threshold-negative', 'a negative threshold caps the uncovered count'],
    ['threshold-not-found', 'a path and a glob that name no covered file'],
    ['threshold-pass', 'thresholds that are met: exit 0, nothing on stderr'],
  ] as const) {
    it(`${what} (${id})`, async () => {
      const ran = await provinoOn(`coverage/${id}`)
      const golden = ran.fixture.golden.observed
      assert.equal(ran.code, golden?.exitCode, ran.stderr)
      assert.equal(ran.lines, golden?.stderr)
      assert.equal(ran.success, golden?.exitCode === 0, '--json success')
    })
  }

  it('--passWithNoTests with no test file still writes the reports and checks the thresholds (threshold-no-tests)', async () => {
    // runJest.ts L338-L352: the scheduler runs on an empty list, so CoverageReporter's
    // `onRunComplete` writes the reports of an empty map and checks `coverageThreshold` over it.
    // Only a group that names a path or a glob misses (`global` reads `Unknown`, which meets
    // nothing and fails nothing), and the run exits 1 though the flag says no tests is a pass.
    const ran = await provinoOn('coverage/threshold-no-tests')
    const { observed } = ran.fixture.golden
    const keep = ran.fixture.manifest.run?.keepLines
    assert.equal(ran.code, observed?.exitCode, ran.stderr)
    assert.equal(observedText(ran.stdout, { roots: [ran.root], keepLines: keep }), observed?.stdout)
    assert.equal(observedText(ran.stderr, { roots: [ran.root], keepLines: keep }), observed?.stderr)
    assert.equal(
      await readFile(join(ran.root, 'coverage', 'coverage-summary.json'), 'utf8'),
      observed?.files?.['coverage/coverage-summary.json'],
    )
    assert.equal(ran.success, false, '--json success')
  })

  it('without --passWithNoTests a run with no test file ends first: no report, no threshold check (threshold-no-tests-no-flag)', async () => {
    const ran = await provinoOn('coverage/threshold-no-tests-no-flag')
    const { observed } = ran.fixture.golden
    const keep = ran.fixture.manifest.run?.keepLines
    assert.equal(ran.code, observed?.exitCode, ran.stderr)
    assert.equal(observedText(ran.stdout, { roots: [ran.root], keepLines: keep }), observed?.stdout)
    assert.equal(observedText(ran.stderr, { roots: [ran.root], keepLines: keep }), observed?.stderr)
    assert.equal(existsSync(join(ran.root, 'coverage', 'coverage-summary.json')), false)
  })

  it('a missed threshold fails the run that passed every test, and its lines are on stderr, not stdout', async () => {
    const ran = await provinoOn('coverage/threshold-global')
    assert.equal(ran.code, 1)
    assert.match(ran.stderr, /Jest: Coverage for statements \(60%\) does not meet "global"/)
  })
})
