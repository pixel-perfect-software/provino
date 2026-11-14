// B17b, T7.9: `provino jest -u` and `provino jest --ci` reach the snapshot engine, case by case
// against black-box `run` goldens recorded from real Jest 30.5.2 (`packages/harness/fixtures/
// snapshot/`): the exit code, and the bytes of the `.snap` file the run leaves. The bin is a child
// process, with a deadline, as a script or CI would run it.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { observedText } from './mask.ts'
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

// B23d B1: a project's `snapshotResolver` (where snapshots are written and read, Jest's texts for
// a resolver that lacks a member or doesn't invert itself) and the snapshot files no test file has
// (DV96: reported, removed under `-u`, through a custom resolver's inverse too). The exit code, the
// captured files and the kept stderr lines equal the goldens.
/**
 * Declared (a DIVERGENCES candidate): Jest builds the resolver again after the run
 * (`TestScheduler`'s `updateSnapshotState`), so a broken one throws there, before `onRunComplete`,
 * and Jest prints no totals. Provino's file failures are Jest's and it prints its totals after them:
 * its kept lines are the golden's followed by exactly the three totals lines.
 */
const TOTALS_AFTER_RESOLVER_FAILURE: ReadonlySet<string> = new Set([
  'snapshot/resolver-inconsistent',
  'snapshot/resolver-missing-member',
])
const TOTALS = /^(Test Suites|Tests|Snapshots):/

const RESOLVER_AND_OBSOLETE: readonly string[] = [
  'snapshot/resolver-custom',
  'snapshot/resolver-inconsistent',
  'snapshot/resolver-missing-member',
  'cli/report-snapshot-obsolete-file',
  'cli/report-snapshot-obsolete-file-update',
]

describe('provino jest: snapshotResolver and obsolete snapshot files against Jest 30.5.2', () => {
  for (const id of RESOLVER_AND_OBSOLETE) {
    it(id, async () => {
      const fixture = await loadFixture(id)
      const expected = fixture.golden.observed
      assert.notEqual(expected?.exitCode, undefined, 'the golden records an exit code')
      const argv = fixture.manifest.run?.argv?.jest ?? []
      const project = await materialize(fixture)
      try {
        const ended = await spawnCli(
          ['jest', `--config=${join(project.root, 'jest.config.json')}`, ...argv],
          { cwd: project.root },
        )
        assert.equal(ended.signal, null, 'it exited, it was not killed')
        assert.equal(ended.code, expected?.exitCode, ended.stderr)
        for (const [file, bytes] of Object.entries(expected?.files ?? {})) {
          const left = await readFile(join(project.root, file), 'utf8').catch(() => null)
          assert.equal(left, bytes, file)
        }
        const kept = observedText(ended.stderr, {
          roots: [project.root],
          keepLines: fixture.manifest.run?.keepLines,
        })
        if (TOTALS_AFTER_RESOLVER_FAILURE.has(id)) {
          const lines = kept.split('\n')
          const golden = (expected?.stderr ?? '').split('\n')
          assert.ok(!golden.some((line) => TOTALS.test(line)), 'Jest printed no totals')
          assert.deepEqual(lines.slice(0, golden.length), golden, 'the file failures are Jest`s')
          assert.deepEqual(
            lines.slice(golden.length).map((line) => TOTALS.exec(line)?.[1]),
            ['Test Suites', 'Tests', 'Snapshots'],
            'then the totals, and nothing else',
          )
        } else {
          assert.equal(kept, expected?.stderr, 'the kept stderr lines')
        }
      } finally {
        await project.dispose()
      }
    })
  }
})
