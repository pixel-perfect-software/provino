import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CANARY } from './dogfood.ts'
import { nodeTestArgs } from './node-test.ts'
import {
  bootstrapProblems,
  SHARD_COUNT,
  SHARD_ONE,
  SPLIT_PACKAGES,
  shardInvocation,
  shardProblems,
} from './test-shards.ts'

const shardOne = [...SPLIT_PACKAGES, ...SHARD_ONE]
const packages = [...shardOne, '@provino/core']

/**
 * Seconds each package's `node --test` summary reported on Node 22.15.0 in one CI run (44796424257,
 * 2026-11-20, the run that put `provino`'s halves in both shards). Packages run side by side, so
 * a duration is contended; a shard's sum is what its job took, at about 2.3 summed seconds per
 * second of wall time in both jobs (1840 s in 814 s, 1121 s in 474 s). A split package lists what
 * each half took, in shard order: Node deals files out by position, so the halves differ. A
 * package not listed weighs nothing here; add it when it is measured.
 */
const WEIGHTS: Readonly<Record<string, number | readonly number[]>> = {
  provino: [801, 366],
  '@provino/harness': 447,
  '@provino/orchestrator': 437,
  '@provino/bench': 133,
  '@provino/dialect-jest': 129,
  '@provino/transform': 124,
  '@provino/reporters': 103,
  'provino-boundaries': 74,
  'provino-packaging': 71,
  '@provino/loader': 58,
  '@provino/lazy': 47,
  '@provino/core': 28,
  '@provino/coverage': 19,
  '@provino/env-shared': 18,
  '@provino/dialect-vitest': 18,
  '@provino/env-jsdom': 16,
  '@provino/mock': 15,
  '@provino/timers': 12,
  '@provino/expect': 11,
  '@provino/config': 8,
  '@provino/snapshot': 8,
  '@provino/policy': 5,
  '@provino/env-node': 5,
  '@provino/resolver': 4,
  '@provino/rpc': 2,
  '@provino/types': 2,
}

/** What each shard should cost in the weights' unit: the packages it runs, its half of a split one. */
function expectedShardCosts(): readonly number[] {
  const weight = (name: string, shard: number): number => {
    const value = WEIGHTS[name] ?? 0
    return typeof value === 'number' ? value : (value[shard] ?? 0)
  }
  return Array.from({ length: SHARD_COUNT }, (_, shard) => {
    const names =
      shard === 0 ? shardOne : Object.keys(WEIGHTS).filter((name) => !SHARD_ONE.includes(name))
    return names.reduce((total, name) => total + weight(name, shard), 0)
  })
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

describe('bootstrapProblems (B27g2)', () => {
  const exists = (): boolean => true
  const pkg = (script: string, expectedScript: string) => ({ name: 'p', script, expectedScript })

  test('a script that is the expected one is fine', () => {
    assert.deepEqual(bootstrapProblems([CANARY], [pkg('run', 'run')], exists), [])
  })

  test('a script that differs runs a bootstrap file on both runners or on neither', () => {
    const problems = bootstrapProblems(
      [CANARY],
      [pkg('run', 'run && node --test a.test.ts')],
      exists,
    )
    assert.equal(problems.length, 1)
    assert.match(
      problems[0] ?? '',
      /test script is "run", expected "run && node --test a\.test\.ts"/,
    )
  })

  test('the canary is required, and an entry must exist', () => {
    assert.match(
      bootstrapProblems([], [], exists).join('\n'),
      /must hold packages\/provino\/test\/bootstrap\/canary\.test\.ts/,
    )
    assert.match(
      bootstrapProblems([CANARY, 'gone.test.ts'], [], (file) => file === CANARY).join('\n'),
      /gone\.test\.ts does not exist/,
    )
  })
})
