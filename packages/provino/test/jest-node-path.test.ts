// A module the config names that only `NODE_PATH` finds (pnpm's `.bin` shims set it to its hidden
// hoist directory): jest-resolve hands `NODE_PATH` to every resolver as `paths`, and the default
// resolver retries them as module directories, so the config reads and the module runs. Held to
// Jest 30.5.2's recordings (`cli/node-path-transform*`), without and with a custom `resolver` that
// calls `defaultResolver`.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadFixture, materialize } from './recorded.ts'
import { spawnCli } from './support.ts'

describe('provino jest finds config modules through NODE_PATH, as Jest 30.5.2 does', () => {
  for (const [id, what] of [
    ['cli/node-path-transform', 'the default resolver'],
    ['cli/node-path-transform-resolver', 'a custom resolver that calls defaultResolver'],
  ] as const) {
    it(`${what} (${id})`, async () => {
      const fixture = await loadFixture(id)
      const project = await materialize(fixture)
      try {
        const ended = await spawnCli(
          ['jest', `--config=${join(project.root, 'jest.config.json')}`, '--ci'],
          { cwd: project.root, env: { NODE_PATH: fixture.manifest.env?.NODE_PATH ?? '' } },
        )
        assert.equal(ended.code, fixture.golden.observed?.exitCode, ended.stderr)
        for (const line of (fixture.golden.observed?.stderr ?? '').split('\n')) {
          assert.ok(ended.stderr.includes(line), `stderr has "${line}":\n${ended.stderr}`)
        }
      } finally {
        await project.dispose()
      }
    })
  }
})
