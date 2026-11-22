// The process half of row 12: the test script, node --test over a real fixture (describe.skip and
// describe.todo included), and Provino run through a stand-in runner that writes a report.
import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { scratchDir } from '../test-support.ts'
import { diffRecords } from './node-test-compare.ts'
import {
  escapeGlob,
  escapeNodeGlob,
  parseTestScript,
  recordNodeTest,
  recordProvino,
  stripFlags,
} from './node-test-run.ts'
import { fakeRunner } from './test-support.ts'

describe('the test script', () => {
  it('keeps the flags that load code, in both spellings, and the globs, whatever the quotes', () => {
    const script =
      "node --test --conditions=provino-source --import ./setup.ts --require 'x.cjs' --test-shard=1/2 --test-reporter spec \"src/**/*.test.ts\" test/**/*.test.mts 'bench/**/*.test.js'"
    assert.deepEqual(parseTestScript(script), {
      flags: ['--conditions=provino-source', '--import', './setup.ts', '--require', 'x.cjs'],
      globs: ['src/**/*.test.ts', 'test/**/*.test.mts', 'bench/**/*.test.js'],
    })
  })

  it('reads the wrapper provino runs through, and a loader value in the next word', () => {
    assert.deepEqual(
      parseTestScript(
        'node ../../tooling/packaging/src/node-test.ts --conditions provino-source --loader ./l.mjs "src/**/*.test.ts"',
      ),
      {
        flags: ['--conditions', 'provino-source', '--loader', './l.mjs'],
        globs: ['src/**/*.test.ts'],
      },
    )
  })

  it('fails with MIGRATE_SCRIPT, not a guess, for a script it does not understand', () => {
    for (const script of [
      undefined,
      '',
      'vitest run',
      'node --test src/a.test.ts && node b.js',
      'FOO=1 node --test "src/**/*.test.ts"',
      'node --test',
      'node "src/**/*.test.ts"',
      'node --test --max-old-space-size 4096 "src/**/*.test.ts"',
      'node --test "src/**/*.test.ts" --other',
      'node --test "src/**/*.test.ts',
      'node --test --import',
    ]) {
      assert.throws(() => parseTestScript(script), { code: 'MIGRATE_SCRIPT' }, String(script))
    }
  })

  it('adds --experimental-strip-types below Node 22.18 only', () => {
    assert.deepEqual(stripFlags('22.15.0'), ['--experimental-strip-types'])
    assert.deepEqual(stripFlags('20.19.0'), ['--experimental-strip-types'])
    assert.deepEqual(stripFlags('22.18.0'), [])
    assert.deepEqual(stripFlags('24.22.1'), [])
  })

  it('escapes a glob so a file named like a pattern matches only itself', () => {
    assert.equal(escapeGlob('src/[slug].test.ts'), 'src/\\[slug\\].test.ts')
    assert.equal(escapeNodeGlob('src/[slug].test.ts'), 'src/[[]slug].test.ts')
    assert.equal(escapeNodeGlob('src/plain.test.ts'), 'src/plain.test.ts')
    assert.equal(escapeGlob('src/a(1).test.ts'), 'src/a\\(1\\).test.ts')
  })
})

const SKIPPED = [
  "import { describe, it } from 'node:test'",
  "describe.skip('skipped suite', () => { it('child a', () => {}); it('child b', () => {}) })",
  "describe.todo('todo suite', () => { it('child c', () => {}) })",
  "describe('live', () => { it('x', () => {}); it('y', () => { throw new Error('no') }) })",
  '',
].join('\n')

describe('node --test as the baseline', () => {
  it('records skipped and todo suites from a real run, and they match what Provino reported', async () => {
    const dir = await realpath(
      scratchDir('run', {
        'package.json': '{"name":"x","type":"module"}',
        'src/a.test.ts': SKIPPED,
      }),
    )
    const records = await recordNodeTest(dir, ['src/a.test.ts'], [])
    assert.deepEqual(
      records.map((r) => [r.name, r.status, r.suite === true]),
      [
        ['skipped suite', 'skip', true],
        ['todo suite > child c', 'todo', false],
        ['live > x', 'pass', false],
        ['live > y', 'fail', false],
      ],
    )
    // What a real `provino run --reporter json` listed for the same file once migrated (recorded
    // 2026-11-22): the skipped suite's tests are listed, as skipped.
    const provino: readonly (readonly [string, string])[] = [
      ['skipped suite > child a', 'skipped'],
      ['skipped suite > child b', 'skipped'],
      ['todo suite > child c', 'todo'],
      ['live > x', 'passed'],
      ['live > y', 'failed'],
    ]
    const after = await recordProvino({
      packageDir: dir,
      files: ['src/a.test.ts'],
      runner: await fakeRunner(dir, provino),
      config: undefined,
    })
    assert.deepEqual(diffRecords(records, after), { missing: [], extra: [], changed: [] })
  })
})

describe('Provino as the second run', () => {
  it('is given exact, escaped file paths, so a [slug].test.ts is one file', async () => {
    const dir = scratchDir('run', { 'package.json': '{"name":"x"}' })
    const runner = await fakeRunner(dir, [], true)
    const records = await recordProvino({
      packageDir: dir,
      files: ['src/[slug].test.ts'],
      runner,
      config: undefined,
    })
    const config = records.find((r) => r.name.startsWith('config > '))
    assert.ok(config !== undefined)
    assert.match(config.name, /"include":\["src\/\\\\\[slug\\\\\]\.test\.ts"\]/)
    assert.ok(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')))
  })

  it('is MIGRATE_RUN when the runner writes no report', async () => {
    const dir = scratchDir('run', { 'package.json': '{"name":"x"}', 'runner.ts': '' })
    await assert.rejects(
      recordProvino({
        packageDir: dir,
        files: [],
        runner: join(dir, 'runner.ts'),
        config: undefined,
      }),
      { code: 'MIGRATE_RUN' },
    )
  })
})
