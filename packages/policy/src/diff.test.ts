import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SnapshotKey } from '@provino/types'
import { diffPolicy, formatPolicyDiff } from './diff.ts'
import { moduleRef } from './module-ref.ts'
import { neutralPolicy } from './neutral.ts'
import { resolvePolicy } from './resolve.ts'

test('equal policies have no differences, even as separate objects', () => {
  const copy = resolvePolicy({ core: { nameSeparator: ' > ' } })
  assert.notEqual(copy, neutralPolicy)
  assert.deepEqual(diffPolicy(neutralPolicy, copy), [])
})

test('a key on one side only is listed, from either side', () => {
  const a = resolvePolicy({ mock: { messages: { ONLY_A: 'a' } } })
  const b = resolvePolicy({ mock: { messages: { ONLY_B: 'b' } } })
  assert.deepEqual(diffPolicy(a, b), [
    { path: 'mock.messages.ONLY_A', a: 'a', b: undefined },
    { path: 'mock.messages.ONLY_B', a: undefined, b: 'b' },
  ])
})

test('every differing key is listed by path, in key order', () => {
  const b = resolvePolicy({
    report: { displaySeparator: ' › ' },
    core: { hookOrder: { afterAll: 'declaration' }, nameSeparator: ' ' },
    mock: { between: { order: ['clear'] } },
  })
  assert.deepEqual(diffPolicy(neutralPolicy, b), [
    { path: 'core.hookOrder.afterAll', a: 'reverse', b: 'declaration' },
    { path: 'core.nameSeparator', a: ' > ', b: ' ' },
    { path: 'mock.between.order', a: neutralPolicy.mock.between.order, b: ['clear'] },
    { path: 'report.displaySeparator', a: ' > ', b: ' › ' },
  ])
})

test('refs compare by module and export; closures by identity', () => {
  const key: SnapshotKey = (n, c) => `${n}${c}`
  const sameRef = resolvePolicy({
    snapshot: { key: moduleRef('@provino/policy/behaviours', 'snapshotKey') },
  })
  assert.deepEqual(diffPolicy(neutralPolicy, sameRef), [])
  assert.deepEqual(
    diffPolicy(resolvePolicy({ snapshot: { key } }), resolvePolicy({ snapshot: { key } })),
    [],
  )
  assert.deepEqual(
    diffPolicy(neutralPolicy, resolvePolicy({ snapshot: { key } })).map((row) => row.path),
    ['snapshot.key'],
  )
})

test('formatPolicyDiff keeps a long array on one line', () => {
  const exclude = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
  const table = formatPolicyDiff(
    diffPolicy(neutralPolicy, resolvePolicy({ orchestrator: { exclude } })),
  )
  assert.equal(table.split('\n').length, 2, table)
})

test('formatPolicyDiff prints an aligned key-by-key table', () => {
  const rows = diffPolicy(
    neutralPolicy,
    resolvePolicy({ core: { nameSeparator: ' ', maxConcurrency: 9 } }),
  )
  assert.equal(
    formatPolicyDiff(rows, ['neutral', 'other']),
    [
      'key                  neutral  other',
      'core.maxConcurrency  5        9',
      "core.nameSeparator   ' > '    ' '",
    ].join('\n'),
  )
})
