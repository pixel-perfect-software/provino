// B17c, T11.10 and U9: the `facade/*` fixtures (`@jest/globals`, `injectGlobals: false`, the served
// `expect` modules, the `globals` config, the rest of the module `jest` object, `jest.setTimeout`, the `fakeTimers` config),
// run through `provino jest` and held to what real Jest 30.5.2 recorded: the exit code (0 only when
// every golden test passed) and each test's status, file by file.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { provinoRun, sorted } from './live-jest.ts'
import { loadFixture, materialize } from './recorded.ts'

const FIXTURES = [
  'facade/globals-identity',
  'facade/inject-globals-off',
  'facade/globals-config',
  'facade/jest-members',
  'facade/jest-set-timeout',
  'facade/fake-timers-global',
  'facade/fake-timers-donotfake',
  'facade/fake-timers-defaults',
] as const

describe('the Jest surface against Jest 30.5.2', () => {
  for (const id of FIXTURES) {
    it(id, async () => {
      const fixture = await loadFixture(id)
      const project = await materialize(fixture)
      try {
        const recorded = new Map<string, string>()
        for (const file of fixture.golden.files) {
          for (const test of file.tests ?? []) {
            recorded.set(`${file.file}::${test.id.path.join(' ')}`, test.status)
          }
        }
        assert.ok(recorded.size > 0)
        const ended = await provinoRun(project.root)
        assert.deepEqual(sorted(ended.statuses), sorted(recorded), ended.stderr)
        const failed = [...recorded.values()].some((status) => status !== 'passed')
        assert.equal(ended.code, failed ? 1 : 0, ended.stderr)
      } finally {
        await project.dispose()
      }
    })
  }
})
