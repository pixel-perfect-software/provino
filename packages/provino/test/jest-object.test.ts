// T11.10: the module `jest` object against real Jest 30.5.2. Its own keys (and their order) are
// the ones the recorder read off the real object (`mocking/api-surface`), and `retryTimes` (T5.10)
// runs a failed test again in the order and as many times as Jest does; its `entireDescribe` is
// refused by name.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { liveJest, provinoRun, sorted } from './live-jest.ts'
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

  it('refuses retryTimes with entireDescribe by name, with the task that builds it', async () => {
    const project = await makeProject({
      'jest.config.json': JEST_CONFIG,
      'tests/retry.test.js': [
        "test('entireDescribe is refused', () => {",
        '  expect(() => jest.retryTimes(2, { entireDescribe: true })).toThrow(/entireDescribe.*T5\\.10/)',
        '})',
        '',
      ].join('\n'),
    })
    const ended = await spawnCli(['jest', '--ci', '-c', 'jest.config.json'], { cwd: project.dir })
    assert.equal(ended.code, 0, ended.stderr)
  })
})

/**
 * A test file that logs each call to `attempts.log` in the project directory, so the order and
 * the number of attempts come from the file itself, whichever runner ran it.
 */
function retryFile(options: string): string {
  return [
    "const fs = require('node:fs')",
    "const log = (line) => fs.appendFileSync(require('node:path').join(__dirname, '..', 'attempts.log'), line + '\\n')",
    `jest.retryTimes(2, ${options})`,
    'const calls = {}',
    'const flaky = (name, failures) => () => {',
    '  calls[name] = (calls[name] || 0) + 1',
    "  log(name + ' #' + calls[name])",
    "  if (calls[name] <= failures) throw new Error(name + ' failed #' + calls[name])",
    '}',
    "beforeEach(() => log('beforeEach'))",
    "test('a fails once', flaky('a', 1))",
    "test('b passes', () => log('b'))",
    "test('c fails twice', flaky('c', 2))",
    "test('d fails every time', flaky('d', 99))",
    "describe('nested', () => {",
    "  test('e fails once', flaky('e', 1))",
    "  test('f passes', () => log('f'))",
    '})',
    "test('g passes', () => log('g'))",
    '',
  ].join('\n')
}

describe('jest.retryTimes against real Jest 30.5.2', () => {
  for (const [name, options] of [
    ['retries after the other tests of the describe', '{}'],
    ['retries at once with retryImmediately', '{ retryImmediately: true }'],
    // Only the statuses and the order of the calls are compared, with both options set. Nothing
    // measures the wait (`runtime/retry-wait` does), and no reporter prints `retryErrors` yet, so
    // Jest's `LOGGING RETRY ERRORS` block is not compared: that is reporter work (B21c).
    [
      'runs the same attempts in the same order with waitBeforeRetry and logErrorsBeforeRetry set',
      '{ waitBeforeRetry: 30, logErrorsBeforeRetry: true }',
    ],
  ] as const) {
    it(name, async () => {
      const files = { 'jest.config.json': JEST_CONFIG, 'tests/retry.test.js': retryFile(options) }
      const live = await makeProject(files)
      const provino = await makeProject(files)
      const jestStatuses = await liveJest(live.dir)
      const ran = await provinoRun(provino.dir)
      // The same statuses, and the same calls in the same order: every attempt, the hooks around it.
      assert.deepEqual(sorted(ran.statuses), sorted(jestStatuses))
      assert.ok([...ran.statuses.values()].includes('failed'), 'one test fails every attempt')
      const logOf = (dir: string): Promise<string> => readFile(join(dir, 'attempts.log'), 'utf8')
      assert.equal(await logOf(provino.dir), await logOf(live.dir))
    })
  }
})
