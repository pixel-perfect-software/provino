// B17c, T11.10 and U9: the `facade/*` fixtures (`@jest/globals`, `injectGlobals: false`, the served
// `expect` modules, the `globals` config), run through `provino jest` and held to what real Jest
// 30.5.2 recorded: the exit code (0 only when every golden test passed) and a line for each file.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { loadFixture, materialize } from './recorded.ts'
import { spawnCli } from './support.ts'

const FIXTURES = [
  'facade/globals-identity',
  'facade/inject-globals-off',
  'facade/globals-config',
] as const

describe('the Jest surface against Jest 30.5.2', () => {
  for (const id of FIXTURES) {
    it(id, async () => {
      const fixture = await loadFixture(id)
      const project = await materialize(fixture)
      try {
        const tests = fixture.golden.files.flatMap((file) => file.tests ?? [])
        const failed = tests.filter((test) => test.status !== 'passed')
        assert.ok(tests.length > 0)
        const ended = await spawnCli(['jest', '--ci', '-c', 'jest.config.json'], {
          cwd: project.root,
        })
        assert.equal(ended.code, failed.length === 0 ? 0 : 1, ended.stderr)
        assert.match(
          ended.stderr,
          new RegExp(`Tests:\\s+${tests.length - failed.length} passed, ${tests.length} total`),
          ended.stderr,
        )
      } finally {
        await project.dispose()
      }
    })
  }
})
