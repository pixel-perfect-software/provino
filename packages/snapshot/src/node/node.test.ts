import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { SnapshotFileReport } from '@provino/types'
import { createSnapshotAggregate, resolveUpdateMode, snapshotRunFails } from './index.ts'

const report = (over: Partial<SnapshotFileReport> = {}): SnapshotFileReport => ({
  file: '/p/__snapshots__/a.snap',
  added: 0,
  matched: 0,
  unmatched: 0,
  updated: 0,
  unchecked: 0,
  uncheckedKeys: [],
  fileDeleted: false,
  ...over,
})

describe('resolveUpdateMode', () => {
  const jest = { ciUpdate: 'none', updateEnvVar: null } as const
  const vitest = { ciUpdate: 'none', updateEnvVar: 'UPDATE_SNAPSHOT' } as const

  test('-u rewrites, in CI too', () => {
    assert.equal(resolveUpdateMode({ update: true, ci: true, env: {}, policy: jest }), 'all')
    assert.equal(resolveUpdateMode({ update: true, ci: false, env: {}, policy: vitest }), 'all')
  })

  test('CI writes nothing and a local run writes new snapshots', () => {
    assert.equal(resolveUpdateMode({ update: false, ci: true, env: {}, policy: jest }), 'none')
    assert.equal(resolveUpdateMode({ update: false, ci: false, env: {}, policy: jest }), 'new')
  })

  test('a policy without a variable ignores the environment', () => {
    const env = { UPDATE_SNAPSHOT: 'all' }
    assert.equal(resolveUpdateMode({ update: false, ci: true, env, policy: jest }), 'none')
  })

  test('the variable names a mode, or means all', () => {
    const run = (value: string, ci = true) =>
      resolveUpdateMode({ update: false, ci, env: { UPDATE_SNAPSHOT: value }, policy: vitest })
    assert.equal(run('new'), 'new')
    assert.equal(run('none', false), 'none')
    assert.equal(run('all'), 'all')
    assert.equal(run('1'), 'all')
    assert.equal(run(''), 'none', 'an empty variable is unset')
  })
})

describe('the aggregate', () => {
  test('sums the counters and counts files as Jest does', () => {
    const aggregate = createSnapshotAggregate()
    aggregate.add(report({ added: 2, matched: 1 }), '/p/a.test.ts')
    aggregate.add(
      report({ unmatched: 1, updated: 3, unchecked: 2, uncheckedKeys: ['x 1', 'y 1'] }),
      '/p/b.test.ts',
    )
    aggregate.add(report({ fileDeleted: true, file: null }), '/p/c.test.ts')
    const summary = aggregate.summary('new')
    assert.deepEqual(summary?.counters, {
      added: 2,
      matched: 1,
      unmatched: 1,
      updated: 3,
      unchecked: 2,
      total: 7,
      filesAdded: 1,
      filesRemoved: 1,
      filesUnmatched: 1,
      filesUpdated: 1,
    })
    assert.deepEqual(summary?.uncheckedKeysByFile, [{ file: '/p/b.test.ts', keys: ['x 1', 'y 1'] }])
    assert.deepEqual(summary?.files, ['/p/__snapshots__/a.snap'])
    assert.equal(summary?.update, 'new')
  })

  test('has no summary when nothing reported', () => {
    assert.equal(createSnapshotAggregate().summary('none'), undefined)
  })
})

describe('snapshotRunFails', () => {
  const obsolete = (update: 'all' | 'new' | 'none', over: Partial<SnapshotFileReport> = {}) => {
    const aggregate = createSnapshotAggregate()
    aggregate.add(report({ unchecked: 1, uncheckedKeys: ['x 1'], ...over }), '/p/a.test.ts')
    return aggregate.summary(update)
  }
  const jest = { obsolete: { failLocal: true, failCI: true } }
  const vitest = { obsolete: { failLocal: false, failCI: true } }

  test('Jest fails on an obsolete snapshot unless it rewrites', () => {
    assert.equal(snapshotRunFails(obsolete('new'), jest), true)
    assert.equal(snapshotRunFails(obsolete('none'), jest), true)
    assert.equal(snapshotRunFails(obsolete('all'), jest), false)
  })

  test('Vitest warns locally and fails when nothing may be written', () => {
    assert.equal(snapshotRunFails(obsolete('new'), vitest), false)
    assert.equal(snapshotRunFails(obsolete('none'), vitest), true)
  })

  test('an obsolete snapshot file counts as an obsolete snapshot', () => {
    assert.equal(snapshotRunFails(obsolete('new', { unchecked: 0, fileDeleted: true }), jest), true)
  })

  test('nothing obsolete, or no snapshots at all, does not fail', () => {
    assert.equal(
      snapshotRunFails(obsolete('new', { unchecked: 0, uncheckedKeys: [] }), jest),
      false,
    )
    assert.equal(snapshotRunFails(undefined, jest), false)
  })
})
