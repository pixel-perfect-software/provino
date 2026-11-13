// `provino jest` applies the project's `clearMocks`, `resetMocks` and `restoreMocks` (T4.10, B17a):
// the Jest config reader maps them to `policy.mock.between`, and the worker's mock cleanup runs
// ahead of every attempt. Each case is a project run through the bin, as a script would run it.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { jestConfigJson, spawnCli } from './support.ts'

const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A project on disk: its `jest.config.json` carrying `cleanup`, and the test files. */
async function project(
  cleanup: Readonly<Record<string, boolean>>,
  tests: Readonly<Record<string, string>>,
): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'provino-jest-cleanup-')))
  made.push(dir)
  const files = {
    'package.json': '{"type":"commonjs"}\n',
    'jest.config.json': jestConfigJson(undefined, cleanup),
    ...tests,
  }
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), text)
  }
  return dir
}

const lines = (...rows: readonly string[]): string => `${rows.join('\n')}\n`

/** Two tests: the first uses a mock, the second asserts what the cleanup left of it. */
const TWO_TESTS = {
  clear: lines(
    'const fn = jest.fn(() => 1)',
    "test('calls it', () => { fn(); expect(fn).toHaveBeenCalledTimes(1) })",
    "test('sees no calls', () => { expect(fn).not.toHaveBeenCalled(); expect(fn()).toBe(1) })",
  ),
  // The implementation is set inside the first test: `resetMocks` also resets before that one.
  reset: lines(
    'const fn = jest.fn()',
    "test('sets one', () => { fn.mockReturnValue(1); expect(fn()).toBe(1) })",
    "test('sees no implementation', () => { expect(fn()).toBeUndefined() })",
  ),
  restore: lines(
    'const target = { value: () => 1 }',
    'const original = target.value',
    "test('spies', () => { jest.spyOn(target, 'value').mockReturnValue(2); expect(target.value()).toBe(2) })",
    "test('sees the original', () => { expect(target.value).toBe(original); expect(target.value()).toBe(1) })",
  ),
}

describe('provino jest applies the project mock cleanup', () => {
  it('clearMocks clears the calls before every test, and keeps the implementation', async () => {
    const dir = await project({ clearMocks: true }, { 'tests/a.test.js': TWO_TESTS.clear })
    const ended = await spawnCli(['jest'], { cwd: dir })
    assert.equal(ended.code, 0, ended.stderr)
    assert.match(ended.stderr, /PASS tests\/a\.test\.js/)
  })

  it('resetMocks resets the implementation before every test', async () => {
    const dir = await project({ resetMocks: true }, { 'tests/a.test.js': TWO_TESTS.reset })
    const ended = await spawnCli(['jest'], { cwd: dir })
    assert.equal(ended.code, 0, ended.stderr)
    assert.match(ended.stderr, /PASS tests\/a\.test\.js/)
  })

  it('restoreMocks restores the spied method before every test', async () => {
    const dir = await project({ restoreMocks: true }, { 'tests/a.test.js': TWO_TESTS.restore })
    const ended = await spawnCli(['jest'], { cwd: dir })
    assert.equal(ended.code, 0, ended.stderr)
    assert.match(ended.stderr, /PASS tests\/a\.test\.js/)
  })

  it('without the keys, nothing is cleaned between tests (the control)', async () => {
    const dir = await project({}, { 'tests/a.test.js': TWO_TESTS.clear })
    const ended = await spawnCli(['jest'], { cwd: dir })
    assert.equal(ended.code, 1, 'the second test sees the first one’s call')
    assert.match(ended.stderr, /FAIL tests\/a\.test\.js/)
  })

  it('says nothing about the three keys: none is "read but not applied"', async () => {
    const dir = await project(
      { clearMocks: true, resetMocks: true, restoreMocks: true },
      { 'tests/a.test.js': lines("test('ok', () => {})") },
    )
    const ended = await spawnCli(['jest'], { cwd: dir })
    assert.equal(ended.code, 0, ended.stderr)
    assert.doesNotMatch(ended.stderr, /clearMocks|resetMocks|restoreMocks/)
  })
})
