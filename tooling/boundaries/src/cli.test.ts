import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'provino'

const cli = fileURLToPath(new URL('./cli.ts', import.meta.url))
const run = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })

// D194 exception (Tyler, 2026-11-23): a whole-repo or whole-corpus test that had no timeout under node:test; 120 s is too tight on a loaded CI runner
test('`check` passes on the repo and says what agreed', { timeout: 600_000 }, () => {
  const result = run('check')
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /no dependency violations found/)
  assert.match(
    result.stdout,
    /boundaries: manifest, workspace, generated files and dependencies agree/,
  )
})

test('an unknown mode exits 2 with usage', () => {
  const result = run('lint')
  assert.equal(result.status, 2)
  assert.match(result.stderr, /usage: node tooling\/boundaries\/src\/cli\.ts check\|write/)
})
