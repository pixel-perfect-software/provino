// `--detectLeaks` (B23d A4): after a file's environment is torn down, `provino jest` collects
// garbage and fails the file whole when anything still reaches its registry or environment, with
// Jest's text; a clean file passes. Held to the lines Jest 30.5.2 printed for the same two
// projects (`cli/detect-leaks`, `cli/detect-leaks-clean`), and to the config key beside the flag.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadFixture, materialize } from './recorded.ts'
import { spawnCli } from './support.ts'

/** The lines of `stderr` the recording kept, sorted as the recording sorted them. */
function kept(stderr: string, keepLines: string): string[] {
  const keep = new RegExp(keepLines)
  return stderr
    .split('\n')
    .filter((line) => keep.test(line))
    .sort()
}

async function ranOn(
  id: string,
  extra: { readonly flags?: readonly string[]; readonly config?: Record<string, unknown> } = {},
): Promise<{
  readonly code: number | null
  readonly lines: string[]
  readonly expected: string[]
  readonly expectedCode: number | null | undefined
  readonly stderr: string
}> {
  const fixture = await loadFixture(id)
  const project = await materialize(fixture)
  try {
    const keepLines = fixture.manifest.run?.keepLines
    assert.ok(keepLines !== undefined, `${id} keeps lines`)
    const configPath = join(project.root, 'jest.config.json')
    if (extra.config !== undefined) {
      const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
      await writeFile(configPath, JSON.stringify({ ...config, ...extra.config }))
    }
    const argv = extra.flags ?? fixture.manifest.run?.argv?.jest ?? []
    const ended = await spawnCli(['jest', `--config=${configPath}`, '--ci', ...argv], {
      cwd: project.root,
    })
    return {
      code: ended.code,
      lines: kept(ended.stderr, keepLines),
      expected: kept(fixture.golden.observed?.stderr ?? '', keepLines),
      expectedCode: fixture.golden.observed?.exitCode,
      stderr: ended.stderr,
    }
  } finally {
    await project.dispose()
  }
}

describe('provino jest --detectLeaks prints what Jest 30.5.2 printed', () => {
  it('a file that leaves a function on a shared core module fails whole, the clean one passes (cli/detect-leaks)', async () => {
    const ran = await ranOn('cli/detect-leaks')
    assert.equal(ran.code, ran.expectedCode, ran.stderr)
    assert.ok(ran.expected.some((line) => line.includes('leaking memory')))
    assert.deepEqual(ran.lines, ran.expected, ran.stderr)
  })

  it('files that leak nothing pass (cli/detect-leaks-clean)', async () => {
    const ran = await ranOn('cli/detect-leaks-clean')
    assert.equal(ran.code, 0, ran.stderr)
    assert.equal(ran.code, ran.expectedCode)
    assert.deepEqual(ran.lines, ran.expected, ran.stderr)
  })

  it('the config key `detectLeaks` does the same as the flag (cli/detect-leaks)', async () => {
    const ran = await ranOn('cli/detect-leaks', { flags: [], config: { detectLeaks: true } })
    assert.equal(ran.code, ran.expectedCode, ran.stderr)
    assert.deepEqual(ran.lines, ran.expected, ran.stderr)
  })

  it('the same on forked workers: --maxWorkers=2 over the two files (cli/detect-leaks)', async () => {
    const ran = await ranOn('cli/detect-leaks', { flags: ['--detectLeaks', '--maxWorkers=2'] })
    assert.equal(ran.code, ran.expectedCode, ran.stderr)
    assert.deepEqual(ran.lines, ran.expected, ran.stderr)
  })

  it('without the flag the leaking file passes (cli/detect-leaks)', async () => {
    const ran = await ranOn('cli/detect-leaks', { flags: [] })
    assert.equal(ran.code, 0, ran.stderr)
    assert.ok(!ran.stderr.includes('leaking memory'))
  })
})
