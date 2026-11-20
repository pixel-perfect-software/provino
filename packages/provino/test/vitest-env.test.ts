// B25g, T11.16: a test under `provino vitest` sees the variables Vitest 5.0.5's CLI and pool set
// (`TEST`, `VITEST`, `NODE_ENV`, `VITEST_MODE`), held to `cli/vitest-env`.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it } from 'node:test'
import { loadVitestFixture, materializeVitest, provinoVitest } from './vitest-recorded.ts'

it('cli/vitest-env', async () => {
  const fixture = await loadVitestFixture('cli/vitest-env')
  const expected = fixture.golden.observed
  const project = await materializeVitest(fixture)
  try {
    const ended = await provinoVitest(fixture, project.root)
    assert.equal(ended.code, expected?.exitCode, ended.stderr)
    assert.equal(
      await readFile(join(project.root, 'env.json'), 'utf8'),
      expected?.files?.['env.json'],
    )
  } finally {
    await project.dispose()
  }
})
