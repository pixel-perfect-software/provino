// `exitCodeFor` and the run's snapshots: an obsolete snapshot fails a run where the policy says so
// for the update mode the run used (Jest: always unless it rewrites; Vitest: when nothing may be
// written).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolvePolicy } from '@provino/policy'
import type { FileResult, Policy, RunSummary, SnapshotRunSummary } from '@provino/types'
import { exitCodeFor } from './exit-code.ts'

const jest: Policy = resolvePolicy({
  orchestrator: { exitCodes: { failure: 7 } },
  snapshot: { obsolete: { failLocal: true, failCI: true } },
})
const vitest: Policy = resolvePolicy({
  orchestrator: { exitCodes: { failure: 7 } },
  snapshot: { obsolete: { failLocal: false, failCI: true } },
})

const file: FileResult = {
  file: { fileId: 'f' as FileResult['file']['fileId'], path: 'a.test.ts', project: '' },
  state: 'pass',
  durationMs: 1,
  errors: [],
}

function obsolete(update: SnapshotRunSummary['update']): RunSummary {
  return {
    reason: 'failed',
    files: [file],
    unhandled: [],
    durationMs: 1,
    snapshots: {
      counters: {
        added: 0,
        matched: 1,
        unmatched: 0,
        updated: 0,
        unchecked: 1,
        total: 1,
        filesAdded: 0,
        filesRemoved: 0,
        filesUnmatched: 0,
        filesUpdated: 0,
      },
      uncheckedKeysByFile: [{ file: 'a.test.ts', keys: ['gone 1'] }],
      update,
      files: [],
    },
  }
}

describe('exitCodeFor: snapshots', () => {
  it('fails a green run with an obsolete snapshot, as Jest does, locally and in CI', () => {
    assert.equal(exitCodeFor(obsolete('new'), { policy: jest }), 7)
    assert.equal(exitCodeFor(obsolete('none'), { policy: jest }), 7)
  })

  it('does not fail a run that rewrites snapshots', () => {
    assert.equal(exitCodeFor(obsolete('all'), { policy: jest }), 0)
  })

  it('fails under Vitest only when nothing may be written', () => {
    assert.equal(exitCodeFor(obsolete('new'), { policy: vitest }), 0)
    assert.equal(exitCodeFor(obsolete('none'), { policy: vitest }), 7)
  })

  it('is 0 for a run with no snapshots', () => {
    const { snapshots: _, ...plain } = obsolete('new')
    assert.equal(exitCodeFor({ ...plain, reason: 'passed' }, { policy: jest }), 0)
  })
})
