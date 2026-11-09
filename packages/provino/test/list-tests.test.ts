// U2: `provino jest --listTests` lists the files real Jest's `--listTests` lists, on the trees in
// `packages/harness/fixtures/discovery/*` (recorded from Jest 30.5.2). Lists compare as sets:
// Jest orders its list by the sequencer (file sizes, cached timings), so its order is not a fact.
// The five R6 repos are `pnpm provino-bench list-tests <repo dir>` (they need B16's installer).
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { FIXTURES, loadFixture, materialize, underRoot } from './recorded.ts'
import { spawnCli } from './support.ts'

const LIST = '.harness-out/jest.json'
const names = (await readdir(join(FIXTURES, 'discovery'))).sort()

/** `provino jest <args>` as a child process in `cwd`: the exit code and what it printed. */
async function provinoJest(
  args: readonly string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const ended = await spawnCli(['jest', ...args], { cwd })
  return { code: ended.code, stdout: ended.stdout, stderr: ended.stderr }
}

describe('provino jest --listTests against Jest 30.5.2', () => {
  it('has recorded fixtures to compare with', () => {
    assert.ok(names.length >= 8, `found ${names.length} fixtures under discovery/`)
  })

  for (const name of names) {
    it(`lists what Jest lists: discovery/${name}`, async () => {
      const fixture = await loadFixture(`discovery/${name}`)
      const expected = fixture.golden.observed?.files?.[LIST]
      assert.equal(typeof expected, 'string', 'the golden holds the list Jest wrote')
      const args = fixture.manifest.run?.argv?.jest ?? []
      assert.ok(args.includes('--listTests'), 'the fixture lists tests')
      const project = await materialize(fixture)
      try {
        // Every fixture states all its discovery options in its overlay, so no recorder default
        // can decide what is found.
        const config = fixture.manifest.config?.jest ?? {}
        assert.ok('testMatch' in config && 'testPathIgnorePatterns' in config)

        const plain = await provinoJest(
          [...args, `--config=${join(project.root, 'jest.config.json')}`],
          project.root,
        )
        assert.equal(plain.code, 0, plain.stderr)
        const asJson = await provinoJest(
          [...args, '--json', `--config=${join(project.root, 'jest.config.json')}`],
          project.root,
        )
        assert.equal(asJson.code, 0, asJson.stderr)

        const want = (expected as string).split('\n').filter((line) => line !== '')
        const lines = underRoot(plain.stdout, project.root)
          .split('\n')
          .filter((line) => line !== '')
          .sort()
        const array = (JSON.parse(underRoot(asJson.stdout, project.root)) as string[]).sort()
        assert.deepEqual(lines, want, `plain list for ${name}`)
        assert.deepEqual(array, want, `JSON list for ${name}`)
      } finally {
        await project.dispose()
      }
    })
  }
})
