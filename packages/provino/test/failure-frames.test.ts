// DV88: the name on each failing frame. Jest 30.5.2's source-map support names a frame after the
// identifier its map holds at the frame's position (`at Object.toBe (frames.test.ts:10:22)`), not
// after the function V8 saw (`at Object.<anonymous>`); `cli/failure-frames` records the text, and
// `provino jest` must print the same lines, name and position, for every failure.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadFixture, materialize } from './recorded.ts'
import { spawnCli } from './support.ts'

/** The lines the recording kept, with the directory in front of the test file taken out. */
function kept(stderr: string, keepLines: string): string[] {
  const keep = new RegExp(keepLines)
  return stderr
    .split('\n')
    .filter((line) => keep.test(line))
    .map((line) => line.replace(/\(.*[\\/]frames\.test\.ts:/, '(frames.test.ts:'))
}

describe('provino jest names a failing test’s frames as Jest 30.5.2 does', () => {
  it('cli/failure-frames: every kept line, name and position', async () => {
    const fixture = await loadFixture('cli/failure-frames')
    const keepLines = fixture.manifest.run?.keepLines
    assert.ok(keepLines !== undefined)
    const project = await materialize(fixture)
    try {
      const ended = await spawnCli(
        ['jest', `--config=${join(project.root, 'jest.config.json')}`, '--ci'],
        { cwd: project.root },
      )
      const expected = kept(fixture.golden.observed?.stderr ?? '', keepLines)
      assert.ok(expected.some((line) => line.includes('Object.toBe')))
      assert.equal(ended.code, fixture.golden.observed?.exitCode)
      assert.deepEqual(kept(ended.stderr, keepLines), expected, ended.stderr)
    } finally {
      await project.dispose()
    }
  })
})
