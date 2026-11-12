// B17c: the Jest surface real repos hit first, through the bin: `moduleNameMapper` and the resolver
// keys (T3.3), `@jest/globals` and U9's served modules (T11.10), and `injectGlobals: false`.
// Statuses are what real Jest gives these projects (the facade fixtures record the objects).
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { spawnCli } from './support.ts'

const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function project(
  config: Readonly<Record<string, unknown>>,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'provino-jest-surface-')))
  made.push(dir)
  const all = {
    'package.json': '{"type":"commonjs"}\n',
    'jest.config.json': JSON.stringify({ testMatch: ['<rootDir>/tests/**/*.test.js'], ...config }),
    ...files,
  }
  for (const [name, text] of Object.entries(all)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), text)
  }
  return dir
}

const lines = (...rows: readonly string[]): string => `${rows.join('\n')}\n`

describe('provino jest: moduleNameMapper and the resolver keys', () => {
  it('maps in order, with array targets and $n', async () => {
    const dir = await project(
      {
        moduleNameMapper: {
          '^@app/(.*)$': ['<rootDir>/missing/$1', '<rootDir>/src/$1'],
          '^style$': '<rootDir>/src/style-stub.js',
        },
        modulePaths: ['<rootDir>/shared'],
      },
      {
        'src/thing.js': "module.exports = 'thing'\n",
        'src/style-stub.js': "module.exports = 'stub'\n",
        'shared/lib.js': "module.exports = 'lib'\n",
        'tests/a.test.js': lines(
          "test('mapped', () => { expect(require('@app/thing')).toBe('thing') })",
          "test('stub', () => { expect(require('style')).toBe('stub') })",
          "test('modulePaths', () => { expect(require('lib')).toBe('lib') })",
        ),
      },
    )
    const ended = await spawnCli(['jest'], { cwd: dir })
    assert.equal(ended.code, 0, ended.stderr)
    assert.match(ended.stderr, /PASS tests\/a\.test\.js/)
    assert.doesNotMatch(ended.stderr, /not applied/)
  })
})

describe('provino jest: @jest/globals and U9', () => {
  it('serves the same objects as the injected globals, with a per-module jest', async () => {
    const dir = await project(
      {},
      {
        'tests/a.test.js': lines(
          "const g = require('@jest/globals')",
          "test('same objects', () => {",
          '  expect(g.expect).toBe(expect)',
          '  expect(g.describe).toBe(describe)',
          '  expect(g.it).toBe(it)',
          "  expect(typeof g.jest.mock).toBe('function')",
          '})',
          "test('expect and @jest/expect', () => {",
          "  expect(require('expect').expect).toBe(expect)",
          "  expect(require('@jest/expect').jestExpect).toBe(expect)",
          '})',
        ),
      },
    )
    const ended = await spawnCli(['jest'], { cwd: dir })
    assert.equal(ended.code, 0, ended.stderr)
  })

  it('works with injectGlobals: false, which removes the globals', async () => {
    const dir = await project(
      { injectGlobals: false },
      {
        'tests/a.test.js': lines(
          "const { describe, it, expect, jest } = require('@jest/globals')",
          "it('has no globals', () => {",
          "  expect(typeof globalThis.test).toBe('undefined')",
          "  expect(typeof globalThis.expect).toBe('undefined')",
          '  expect(jest.fn(() => 1)()).toBe(1)',
          '})',
        ),
      },
    )
    const ended = await spawnCli(['jest'], { cwd: dir })
    assert.equal(ended.code, 0, ended.stderr)
  })
})
