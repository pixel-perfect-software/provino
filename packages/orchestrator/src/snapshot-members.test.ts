// A run over several projects judges each project's snapshots by its own policy and merges them.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SnapshotFileReport } from '@provino/types'
import { mergedSnapshots, snapshotMember, snapshotsFailRun } from './snapshot-members.ts'

const lenient = { obsolete: { failLocal: false, failCI: false } }
const strict = { obsolete: { failLocal: true, failCI: true } }

const report = (unchecked: number): SnapshotFileReport =>
  ({
    added: 0,
    matched: 1,
    unmatched: 0,
    updated: 0,
    unchecked,
    uncheckedKeys: unchecked > 0 ? ['gone 1'] : [],
    fileDeleted: false,
    file: null,
  }) as unknown as SnapshotFileReport

describe('snapshot members', () => {
  it('fails the run when any project’s own rule does, whichever comes first', () => {
    const first = snapshotMember('none', lenient)
    const second = snapshotMember('none', strict)
    first.aggregate.add(report(0), 'a.test.js')
    second.aggregate.add(report(1), 'b.test.js')
    assert.equal(snapshotsFailRun([first, second]), true)
    assert.equal(snapshotsFailRun([second, first]), true)
  })

  it('does not fail on a lenient project’s obsolete snapshot beside a strict project with none', () => {
    const first = snapshotMember('none', strict)
    const second = snapshotMember('none', lenient)
    first.aggregate.add(report(0), 'a.test.js')
    second.aggregate.add(report(1), 'b.test.js')
    assert.equal(snapshotsFailRun([first, second]), false)
  })

  it('merges every project’s counters and unchecked keys for display', () => {
    const first = snapshotMember('none', strict)
    const second = snapshotMember('none', lenient)
    first.aggregate.add(report(1), 'a.test.js')
    second.aggregate.add(report(1), 'b.test.js')
    const merged = mergedSnapshots([first, second])
    assert.equal(merged?.counters.unchecked, 2)
    assert.equal(merged?.counters.matched, 2)
    assert.deepEqual(
      merged?.uncheckedKeysByFile.map((entry) => entry.file),
      ['a.test.js', 'b.test.js'],
    )
  })

  it('has no summary when nothing reported', () => {
    assert.equal(mergedSnapshots([snapshotMember('none', strict)]), undefined)
  })
})
