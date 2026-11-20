import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { nodeTestArgs } from './node-test.ts'
import {
  SHARD_COUNT,
  SHARD_ONE,
  SPLIT_PACKAGES,
  shardInvocation,
  shardProblems,
} from './test-shards.ts'

const shardOne = [...SPLIT_PACKAGES, ...SHARD_ONE]
const packages = [...shardOne, '@provino/core']

/**
 * Seconds each package took in CI on Node 22.15.0 (main, run 44770476921, 2026-11-20), the
 * `duration_ms` of its `node --test` summary. Packages run side by side on 4 CPUs, so a duration
 * is inflated by contention: shard 2's packages summed 1704 s in a job that took 365 s, a ratio of
 * `CONTENTION`. `provino` and `@provino/dialect-jest` ran nearly alone (575 s and 43 s of wall
 * time), so they are divided by it to share the packages' unit. A package not listed weighs
 * nothing here; add it when it is measured.
 */
const CONTENTION = 365 / 1704
const WEIGHTS: Readonly<Record<string, number>> = {
  provino: 575 / CONTENTION,
  '@provino/dialect-jest': 43 / CONTENTION,
  '@provino/harness': 364.4,
  '@provino/orchestrator': 356.1,
  '@provino/bench': 262.5,
  '@provino/transform': 121.6,
  '@provino/reporters': 116.6,
  'provino-boundaries': 90.6,
  'provino-packaging': 83.4,
  '@provino/loader': 72.1,
  '@provino/lazy': 36.8,
  '@provino/core': 33.1,
  '@provino/dialect-vitest': 29.1,
  '@provino/coverage': 23.6,
  '@provino/env-jsdom': 20.9,
  '@provino/expect': 17.7,
  '@provino/env-shared': 16,
  '@provino/timers': 14.5,
  '@provino/mock': 14.4,
  '@provino/config': 8.3,
  '@provino/snapshot': 7.6,
  '@provino/policy': 4.5,
  '@provino/env-node': 4.4,
  '@provino/resolver': 2.4,
  '@provino/rpc': 1.9,
  '@provino/types': 1.4,
}

/** What each shard should cost in the weights' unit: its whole packages plus half of each split one. */
function expectedShardCosts(): readonly number[] {
  const sum = (names: readonly string[]) =>
    names.reduce((total, name) => total + (WEIGHTS[name] ?? 0), 0)
  const split = sum(SPLIT_PACKAGES) / SHARD_COUNT
  const whole = Object.keys(WEIGHTS).filter((name) => !SPLIT_PACKAGES.includes(name))
  return [sum(SHARD_ONE) + split, sum(whole) - sum(SHARD_ONE) + split]
}

const NODE_TEST = fileURLToPath(new URL('./node-test.ts', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'test-shards.'))
after(() => rmSync(scratch, { recursive: true, force: true }))

/** A directory of seven one-test files, `f1` to `f7`, and the files a run of them reports. */
function probe(): { dir: string; ran: (args: readonly string[], shard?: string) => string[] } {
  const dir = mkdtempSync(join(scratch, 'probe.'))
  mkdirSync(dir, { recursive: true })
  for (let index = 1; index <= 7; index += 1) {
    writeFileSync(
      join(dir, `f${index}.test.ts`),
      `import { test } from 'node:test'\ntest('f${index}', () => {})\n`,
    )
  }
  const ran = (args: readonly string[], shard?: string): string[] => {
    // A child inside a test run would report to this run, not to its stdout.
    const { NODE_TEST_CONTEXT: _context, ...rest } = process.env
    const env = { ...rest, PROVINO_TEST_SHARD: shard ?? '' }
    const result = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', env })
    assert.equal(result.status, 0, result.stderr)
    return [...result.stdout.matchAll(/^ok \d+ - (f\d)\b/gm)].map((m) => m[1] ?? '').sort()
  }
  return { dir, ran }
}

describe('test shards', () => {
  test('shard 1 selects its packages, shard 2 the rest, and each gets its half of the split ones', () => {
    assert.deepEqual(shardInvocation(1), {
      filters: shardOne.map((name) => `--filter=${name}`),
      env: { PROVINO_TEST_SHARD: '1/2' },
    })
    assert.deepEqual(shardInvocation(2), {
      filters: SHARD_ONE.map((name) => `--filter=!${name}`),
      env: { PROVINO_TEST_SHARD: '2/2' },
    })
    assert.throws(() => shardInvocation(0), RangeError)
    assert.throws(() => shardInvocation(3), RangeError)
  })

  test('every package in exactly one shard, and a split one in both, is no problem', () => {
    assert.deepEqual(shardProblems(packages, [shardOne, ['provino', '@provino/core']]), [])
  })

  test('a package in no shard, in both, unknown or a split one in one is named', () => {
    assert.deepEqual(shardProblems(packages, [shardOne, ['provino']]), [
      '@provino/core has tests and is in no shard',
    ])
    assert.deepEqual(
      shardProblems(packages, [
        [...shardOne, '@provino/core'],
        ['provino', '@provino/core'],
      ]),
      ['@provino/core is in shards 1 and 2'],
    )
    assert.deepEqual(shardProblems(packages, [shardOne, ['provino', '@provino/core', 'ghost']]), [
      'shard 2 ran ghost, which is not a package with a test script',
    ])
    assert.deepEqual(shardProblems(packages, [shardOne, ['@provino/core']]), [
      'provino is split and must be in every shard; it is in 1',
    ])
  })

  test('a name this file lists that is not a package with tests is named', () => {
    const problems = shardProblems(['@provino/core', ...SHARD_ONE], [[], ['@provino/core']])
    assert.ok(
      problems.includes('test-shards.ts names provino, which is not a package with a test script'),
    )
  })

  test('the measured weights put the two shards within 15% of each other', () => {
    const [one = 0, two = 0] = expectedShardCosts()
    assert.ok(Math.abs(one - two) / Math.max(one, two) < 0.15, `${one} against ${two}`)
  })
})

describe('the file split of a package', () => {
  test('Node ignores --test-shard after the first test pattern, which is why the flag goes first', () => {
    const { ran } = probe()
    assert.equal(ran(['--test', '--test-reporter=tap', '*.test.ts', '--test-shard=1/2']).length, 7)
    assert.equal(ran(['--test', '--test-shard=1/2', '--test-reporter=tap', '*.test.ts']).length, 4)
  })

  test('nodeTestArgs puts the shard before the patterns, and a bad one is refused', () => {
    assert.deepEqual(nodeTestArgs('2/2', ['--conditions=x', 'a']), [
      '--test',
      '--test-shard=2/2',
      '--conditions=x',
      'a',
    ])
    assert.deepEqual(nodeTestArgs(undefined, ['a']), ['--test', 'a'])
    assert.deepEqual(nodeTestArgs('', ['a']), ['--test', 'a'])
    assert.throws(() => nodeTestArgs('1', ['a']), RangeError)
    assert.throws(() => nodeTestArgs('0/2', ['a']), RangeError)
  })

  test('the shards of node-test.ts run disjoint halves that add up to every file', () => {
    const { ran } = probe()
    const args = [NODE_TEST, '--test-reporter=tap', '*.test.ts']
    const all = ran(args)
    const halves = Array.from({ length: SHARD_COUNT }, (_, index) =>
      ran(args, `${index + 1}/${SHARD_COUNT}`),
    )
    assert.equal(all.length, 7)
    assert.deepEqual(halves.flat().sort(), all)
    assert.ok(halves.every((half) => half.length > 0 && half.length < all.length))
  })
})
