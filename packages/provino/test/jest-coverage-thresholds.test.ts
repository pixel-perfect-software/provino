// T8.11 through the bin: `provino jest` with `coverageThreshold`, against what real Jest 30.5.2
// printed for the same project (`coverage/threshold-*`): the `Jest: ...` lines on stderr in Jest's
// order and words (a glob group names each file, `<root>` the work directory), and the exit code.
// `--json`'s `success` is false for a missed threshold, as Jest's reporter error makes it.
import assert from 'node:assert/strict'
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
      ...extra,
    ],
    { cwd: root, env: RECORDER_ENV },
  )
  const lines = observedText(ended.stderr, { roots: [root] })
    .split('\n')
    .filter((line) => line.startsWith('Jest: '))
    .join('\n')
  const json = JSON.parse(await readFile(outputFile, 'utf8')) as Record<string, Json>
  return { fixture, code: ended.code, lines, success: json.success, stderr: ended.stderr }
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

  it('a missed threshold fails the run that passed every test, and its lines are on stderr, not stdout', async () => {
    const ran = await provinoOn('coverage/threshold-global')
    assert.equal(ran.code, 1)
    assert.match(ran.stderr, /Jest: Coverage for statements \(60%\) does not meet "global"/)
  })
})
