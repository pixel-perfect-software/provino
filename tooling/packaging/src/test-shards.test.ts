import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { SHARD_ONE, shardFilters, shardProblems } from './test-shards.ts'

const packages = ['provino', '@provino/dialect-jest', '@provino/core', '@provino/harness']

describe('test shards', () => {
  test('shard 1 selects its packages and shard 2 excludes them', () => {
    assert.deepEqual(
      shardFilters(1),
      SHARD_ONE.map((name) => `--filter=${name}`),
    )
    assert.deepEqual(
      shardFilters(2),
      SHARD_ONE.map((name) => `--filter=!${name}`),
    )
    assert.throws(() => shardFilters(3), RangeError)
  })

  test('every package in exactly one shard is no problem', () => {
    const ran = [
      ['provino', '@provino/dialect-jest'],
      ['@provino/core', '@provino/harness'],
    ]
    assert.deepEqual(shardProblems(packages, ran), [])
  })

  test('a package in no shard, in both, or unknown is named', () => {
    const missed = shardProblems(packages, [
      ['provino', '@provino/dialect-jest'],
      ['@provino/core'],
    ])
    assert.deepEqual(missed, ['@provino/harness has tests and is in no shard'])
    const both = shardProblems(packages, [
      ['provino', '@provino/dialect-jest', '@provino/core'],
      ['@provino/core', '@provino/harness'],
    ])
    assert.deepEqual(both, ['@provino/core is in shards 1 and 2'])
    const unknown = shardProblems(packages, [
      ['provino', '@provino/dialect-jest'],
      ['@provino/core', '@provino/harness', 'ghost'],
    ])
    assert.match(unknown.join('\n'), /ghost/)
  })

  test('a shard-1 name that is not a package with tests is named', () => {
    const problems = shardProblems(['provino'], [['provino'], []])
    assert.match(problems.join('\n'), /SHARD_ONE names @provino\/dialect-jest/)
  })
})
