import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  expectedShardCosts,
  SHARD_ONE,
  SPLIT_PACKAGES,
  shardFilters,
  shardProblems,
  splitArgs,
} from './test-shards.ts'

const shardOne = [...SPLIT_PACKAGES, ...SHARD_ONE]
const packages = [...shardOne, '@provino/core']

describe('test shards', () => {
  test('shard 1 selects its packages and shard 2 excludes them and the split ones', () => {
    assert.deepEqual(
      shardFilters(1),
      SHARD_ONE.map((name) => `--filter=${name}`),
    )
    assert.deepEqual(
      shardFilters(2),
      [...SHARD_ONE, ...SPLIT_PACKAGES].map((name) => `--filter=!${name}`),
    )
    assert.throws(() => shardFilters(3), RangeError)
  })

  test('each shard runs its own half of the split packages', () => {
    assert.deepEqual(splitArgs(1), ['--filter=provino', '--', '--test-shard=1/2'])
    assert.deepEqual(splitArgs(2), ['--filter=provino', '--', '--test-shard=2/2'])
    assert.throws(() => splitArgs(0), RangeError)
    assert.throws(() => splitArgs(3), RangeError)
  })

  test('every package in exactly one shard, and a split one in both, is no problem', () => {
    const ran = [shardOne, ['provino', '@provino/core']]
    assert.deepEqual(shardProblems(packages, ran), [])
  })

  test('a package in no shard, in both, unknown or a split one in one is named', () => {
    const missed = shardProblems(packages, [shardOne, ['provino']])
    assert.match(missed.join('\n'), /@provino\/core has tests and is in no shard/)
    const both = shardProblems(packages, [
      [...shardOne, '@provino/core'],
      ['provino', '@provino/core'],
    ])
    assert.match(both.join('\n'), /@provino\/core is in shards 1 and 2/)
    const unknown = shardProblems(packages, [shardOne, ['provino', '@provino/core', 'ghost']])
    assert.match(unknown.join('\n'), /ghost/)
    const unsplit = shardProblems(packages, [shardOne, ['@provino/core']])
    assert.match(unsplit.join('\n'), /provino is split and must be in every shard; it is in 1/)
  })

  test('a shard-1 or split name that is not a package with tests is named', () => {
    const problems = shardProblems(['@provino/core'], [[], ['@provino/core']])
    assert.match(problems.join('\n'), /SHARD_ONE names @provino\/dialect-jest/)
    assert.match(problems.join('\n'), /SPLIT_PACKAGES names provino/)
  })

  test('the measured weights put the two shards within 15% of each other', () => {
    const [one = 0, two = 0] = expectedShardCosts()
    assert.ok(Math.abs(one - two) / Math.max(one, two) < 0.15, `${one} against ${two}`)
  })
})
