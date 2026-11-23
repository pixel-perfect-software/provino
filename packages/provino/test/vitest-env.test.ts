// B25g, T11.16: a test under `provino vitest` sees the variables Vitest 5.0.5's CLI and pool set
// (`TEST`, `VITEST`, `NODE_ENV`, `VITEST_MODE`), held to `cli/vitest-env`.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it } from 'provino'
import { provinoVitest, withVitestFixture } from './vitest-recorded.ts'

it('cli/vitest-env', () =>
  withVitestFixture('cli/vitest-env', async (fixture, root) => {
    const expected = fixture.golden.observed
    const ended = await provinoVitest(fixture, root)
    assert.equal(ended.code, expected?.exitCode, ended.stderr)
    assert.equal(await readFile(join(root, 'env.json'), 'utf8'), expected?.files?.['env.json'])
  }))
