import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('./cli.ts', import.meta.url))
const run = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })

test('`check` passes on the repo and says what agreed', () => {
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
