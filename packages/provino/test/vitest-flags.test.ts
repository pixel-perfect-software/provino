// B25g (D183): the Vitest flags `provino vitest` applies, each held to a `cli/vitest-*` golden
// recorded from Vitest 5.0.5. The bin is a child process.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { spawnCli } from './support.ts'
import { keptLines, provinoVitest, reportedFiles, withVitestFixture } from './vitest-recorded.ts'

const OUTPUT = '.harness-out/provino.json'
const JSON_REPORT = ['--reporter=json', `--outputFile=${OUTPUT}`]

describe('provino vitest flags against Vitest 5.0.5', () => {
  it('--exclude adds to the config excludes (cli/vitest-exclude-additive)', () =>
    withVitestFixture('cli/vitest-exclude-additive', async (fixture, root) => {
      const ended = await provinoVitest(fixture, root, JSON_REPORT)
      assert.equal(ended.code, fixture.golden.observed?.exitCode, ended.stderr.slice(0, 500))
      assert.deepEqual(
        await reportedFiles(root, OUTPUT),
        fixture.golden.files?.map(({ file, status }) => ({ file, status })),
      )
    }))

  it('--dir starts discovery there (cli/vitest-dir)', () =>
    withVitestFixture('cli/vitest-dir', async (fixture, root) => {
      const ended = await provinoVitest(fixture, root, JSON_REPORT)
      assert.equal(ended.code, fixture.golden.observed?.exitCode, ended.stderr.slice(0, 500))
      assert.deepEqual(
        await reportedFiles(root, OUTPUT),
        fixture.golden.files?.map(({ file, status }) => ({ file, status })),
      )
    }))

  it('--allowOnly lets .only run under CI (cli/vitest-allow-only)', () =>
    withVitestFixture('cli/vitest-allow-only', async (fixture, root) => {
      const ended = await provinoVitest(fixture, root, JSON_REPORT)
      assert.equal(ended.code, fixture.golden.observed?.exitCode, ended.stderr.slice(0, 500))
      assert.deepEqual(
        await reportedFiles(root, OUTPUT),
        fixture.golden.files?.map(({ file, status }) => ({ file, status })),
      )
    }))

  it('--silent prints no console output (cli/vitest-silent)', () =>
    withVitestFixture('cli/vitest-silent', async (fixture, root) => {
      const expected = fixture.golden.observed
      const ended = await provinoVitest(fixture, root)
      assert.equal(ended.code, expected?.exitCode, ended.stderr.slice(0, 500))
      assert.equal(keptLines(fixture, ended.stdout), expected?.stdout)
      assert.equal(keptLines(fixture, ended.stderr), expected?.stderr)
      // The control: without the flag the lines are there.
      const loud = await spawnCli(['vitest', 'run', '--reporter=default'], {
        cwd: root,
        env: { CI: '1', TZ: 'UTC', NO_COLOR: '1' },
      })
      assert.match(loud.stdout + loud.stderr, /MARKER stdout/)
    }))

  it('--silent=passed-only is refused by name (parked, D183)', () =>
    withVitestFixture('cli/vitest-silent', async (_fixture, root) => {
      const ended = await spawnCli(['vitest', 'run', '--silent=passed-only'], {
        cwd: root,
        env: { CI: '1', TZ: 'UTC', NO_COLOR: '1' },
      })
      assert.equal(ended.code, 1)
      assert.match(ended.stderr, /--silent=passed-only is not supported \(parked \(D183\)\)/)
      assert.doesNotMatch(ended.stdout + ended.stderr, /MARKER/)
    }))

  it('--logHeapUsage prints a heap line per file (cli/vitest-log-heap-usage)', () =>
    withVitestFixture('cli/vitest-log-heap-usage', async (fixture, root) => {
      const expected = fixture.golden.observed
      const ended = await provinoVitest(fixture, root)
      assert.equal(ended.code, expected?.exitCode, ended.stderr.slice(0, 500))
      // Provino's own words (D173): one heap figure per file, as Vitest prints one per file.
      const heapLines = (text: string): number =>
        text.split('\n').filter((line) => /heap/.test(line)).length
      assert.equal(heapLines(ended.stdout + ended.stderr), heapLines(expected?.stdout ?? ''))
    }))
})
