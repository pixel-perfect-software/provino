// U3: `provino jest` ends with the exit codes Jest 30.5.2 ends with, case by case against black-box
// `run` goldens recorded from the real runner (`packages/harness/fixtures/`). The bin is a child
// process, with a deadline, as a script or CI would run it.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadFixture, materialize, underRoot } from './recorded.ts'
import { spawnCli } from './support.ts'

interface Case {
  readonly name: string
  readonly fixture: string
}

const CASES: readonly Case[] = [
  { name: 'pass', fixture: 'cli/pass' },
  { name: 'a failing test', fixture: 'policy/orchestrator-exit-codes' },
  { name: 'no tests found', fixture: 'policy/orchestrator-no-tests' },
  { name: '--passWithNoTests', fixture: 'cli/pass-with-no-tests' },
  { name: 'a flag Jest does not know', fixture: 'cli/unknown-flag' },
  { name: 'the singular --testPathPattern', fixture: 'cli/jest-test-path-pattern' },
  { name: 'a config Jest refuses', fixture: 'cli/bad-config' },
]

describe('provino jest exit codes against Jest 30.5.2', () => {
  for (const { name, fixture: id } of CASES) {
    it(`${name} (${id})`, async () => {
      const fixture = await loadFixture(id)
      const expected = fixture.golden.observed
      assert.notEqual(expected?.exitCode, undefined, 'the golden records an exit code')
      const project = await materialize(fixture)
      try {
        const args = fixture.manifest.run?.argv?.jest ?? []
        const ended = await spawnCli(
          ['jest', `--config=${join(project.root, 'jest.config.json')}`, ...args],
          { cwd: project.root },
        )
        assert.equal(ended.signal, null, 'it exited, it was not killed')
        assert.equal(ended.code, expected?.exitCode, ended.stderr)
        if (expected?.stderr !== undefined) {
          // The golden holds the lines the fixture's `keepLines` kept: each is in what we print.
          const printed = underRoot(ended.stderr, project.root)
          for (const line of expected.stderr.split('\n')) {
            assert.ok(printed.includes(line), `stderr has "${line}":\n${printed}`)
          }
        }
      } finally {
        await project.dispose()
      }
    })
  }
})
