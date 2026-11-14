// `provino jest` with `['github-actions', { silent: false }]` (B23d A4, DV90): the result tree in
// `::group::` blocks, the console output and the closing `Errors thrown in` group, held to what
// Jest 30.5.2 wrote for the same project (`cli/github-actions-not-silent`: its `keepLines` and
// `mask`, stdout empty). The environment is the fixture's (`GITHUB_ACTIONS=true`) on any machine,
// so a runner that sets it itself changes neither side.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { observedText } from './mask.ts'
import { loadFixture, materialize } from './recorded.ts'
import { spawnCli, withoutNodeNoise } from './support.ts'

describe('provino jest prints the github-actions result tree as Jest 30.5.2 does', () => {
  it('cli/github-actions-not-silent: the kept stderr lines and the exit code', async () => {
    const fixture = await loadFixture('cli/github-actions-not-silent')
    const { run, env } = fixture.manifest
    const observed = fixture.golden.observed
    assert.ok(run !== undefined && observed !== undefined)
    const project = await materialize(fixture)
    try {
      const ended = await spawnCli(
        [
          'jest',
          `--config=${join(project.root, 'jest.config.json')}`,
          ...(run.argv?.jest ?? ['--ci']),
        ],
        { cwd: project.root, env: { CI: '1', NO_COLOR: '1', TZ: 'UTC', ...env } },
      )
      assert.equal(ended.code, observed.exitCode)
      assert.equal(ended.stdout, '')
      const printed = observedText(withoutNodeNoise(ended.stderr), {
        roots: [project.root],
        keepLines: run.keepLines,
        mask: run.mask,
      })
      assert.equal(printed, observed.stderr)
    } finally {
      await project.dispose()
    }
  })
})
