// B17b, T7.9: `provino jest -u` and `provino jest --ci` reach the snapshot engine, case by case
// against black-box `run` goldens recorded from real Jest 30.5.2 (`packages/harness/fixtures/
// snapshot/`): the exit code, and the bytes of the `.snap` file the run leaves. The bin is a child
// process, with a deadline, as a script or CI would run it.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadFixture, materialize } from './recorded.ts'
import { spawnCli } from './support.ts'

interface Case {
  readonly name: string
  readonly fixture: string
  /** `--ci` or `--ci=false` is always given, so the CI variable of the machine doesn't decide. */
  readonly args: readonly string[]
}

const CASES: readonly Case[] = [
  {
    name: '-u rewrites a snapshot that differs, writes a new one and removes an obsolete one',
    fixture: 'snapshot/update-all',
    args: ['--ci=false', '-u'],
  },
  {
    name: '--updateSnapshot is -u',
    fixture: 'snapshot/update-all',
    args: ['--ci=false', '--updateSnapshot'],
  },
  {
    name: '--ci writes no snapshot, and a missing one fails the run',
    fixture: 'snapshot/new-ci',
    args: ['--ci'],
  },
  {
    name: '--ci fails the run on an obsolete snapshot and leaves the file as it was',
    fixture: 'snapshot/obsolete-ci',
    args: ['--ci'],
  },
]

describe('provino jest -u and --ci against Jest 30.5.2', () => {
  for (const { name, fixture: id, args } of CASES) {
    it(`${name} (${id})`, async () => {
      const fixture = await loadFixture(id)
      const expected = fixture.golden.observed
      assert.notEqual(expected?.exitCode, undefined, 'the golden records an exit code')
      const captured = Object.entries(expected?.files ?? {})
      assert.ok(captured.length > 0, 'the golden captures a file')
      const project = await materialize(fixture)
      try {
        const ended = await spawnCli(
          ['jest', `--config=${join(project.root, 'jest.config.json')}`, ...args],
          { cwd: project.root },
        )
        assert.equal(ended.signal, null, 'it exited, it was not killed')
        assert.equal(ended.code, expected?.exitCode, ended.stderr)
        for (const [file, bytes] of captured) {
          const left = await readFile(join(project.root, file), 'utf8').catch(() => null)
          assert.equal(left, bytes, file)
        }
      } finally {
        await project.dispose()
      }
    })
  }
})
