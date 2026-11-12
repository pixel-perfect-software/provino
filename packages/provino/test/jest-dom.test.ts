// B17c end to end: a project on `jest-environment-jsdom`, with a mapper and two docblocks, read by
// the Jest config reader and run through `provino jest` (D44: the project's own environment
// package, run through the adapter). Held to the verdicts real Jest 30.5.2 recorded for the same
// tree (`env/jsdom-project`): every test passes, file by file.
import assert from 'node:assert/strict'
import { mkdir, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { FIXTURES, loadFixture, materialize } from './recorded.ts'
import { spawnCli } from './support.ts'

/** The real directory of a package the harness installs (the project's own copy, as pnpm links it). */
function packageDir(name: string): string {
  const require = createRequire(join(FIXTURES, 'x.js'))
  return dirname(require.resolve(`${name}/package.json`))
}

describe('a Jest project on jsdom against Jest 30.5.2', () => {
  it('env/jsdom-project: every file passes as in Jest, with its docblocks and mapper', async () => {
    const fixture = await loadFixture('env/jsdom-project')
    const project = await materialize(fixture)
    try {
      await mkdir(join(project.root, 'node_modules'), { recursive: true })
      for (const name of ['jest-environment-jsdom', 'jest-environment-node']) {
        await symlink(packageDir(name), join(project.root, 'node_modules', name))
      }
      const expected = fixture.golden.files.flatMap((file) => file.tests ?? [])
      const ended = await spawnCli(['jest', '--ci', '-c', 'jest.config.json'], {
        cwd: project.root,
      })
      assert.equal(ended.code, 0, ended.stderr)
      for (const file of fixture.golden.files) {
        assert.match(
          ended.stderr,
          new RegExp(`PASS ${file.file.replace('.', '\\.')}`),
          ended.stderr,
        )
      }
      assert.match(
        ended.stderr,
        new RegExp(`Tests:\\s+${expected.length} passed, ${expected.length} total`),
        ended.stderr,
      )
      assert.doesNotMatch(ended.stderr, /not applied/)
    } finally {
      await project.dispose()
    }
  })
})
