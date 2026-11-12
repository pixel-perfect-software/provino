// T11.10: the module `jest` object against real Jest 30.5.2. Its own keys (and their order) are
// the ones the recorder read off the real object (`mocking/api-surface`), and `retryTimes`, which
// needs deferred retries (T5.10), is refused by name instead of running in another order.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { FIXTURES } from './recorded.ts'
import { spawnCli, trackedProjects } from './support.ts'

const makeProject = trackedProjects()

/** The keys the recorder saw on Jest's `jest`: the first line of the golden's trace. */
async function recordedKeys(): Promise<readonly string[]> {
  const golden = JSON.parse(
    await readFile(join(FIXTURES, 'mocking/api-surface/__goldens__/jest.json'), 'utf8'),
  ) as { trace: string[] }
  const [first] = golden.trace
  assert.ok(first, 'the golden has a trace')
  return (JSON.parse(first) as { value: string[] }).value
}

const JEST_CONFIG = JSON.stringify({ testMatch: ['<rootDir>/tests/**/*.test.js'] })

describe('the module jest object', () => {
  it('has the keys Jest 30.5.2 has, in its order', async () => {
    const keys = await recordedKeys()
    assert.ok(keys.length > 40)
    const project = await makeProject({
      'jest.config.json': JEST_CONFIG,
      'tests/keys.test.js': `test('keys', () => { expect(Object.keys(jest)).toEqual(${JSON.stringify(keys)}) })\n`,
    })
    const ended = await spawnCli(['jest', '--ci', '-c', 'jest.config.json'], { cwd: project.dir })
    assert.equal(ended.code, 0, ended.stderr)
  })

  it('refuses retryTimes by name, with the task that builds it', async () => {
    const project = await makeProject({
      'jest.config.json': JEST_CONFIG,
      'tests/retry.test.js': [
        "test('retryTimes is refused', () => {",
        '  expect(() => jest.retryTimes(2)).toThrow(/jest\\.retryTimes is not supported yet.*T5\\.10/)',
        '})',
        '',
      ].join('\n'),
    })
    const ended = await spawnCli(['jest', '--ci', '-c', 'jest.config.json'], { cwd: project.dir })
    assert.equal(ended.code, 0, ended.stderr)
  })
})
