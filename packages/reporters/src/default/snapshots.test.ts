import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ReportPolicy, SnapshotRunSummary } from '@provino/types'
import { createReporterBus } from '../bus.ts'
import { type FileSpec, output, playRun } from '../internal/test-support.ts'
import { defaultReporter } from './reporter.ts'

const POLICY: ReportPolicy = {
  displaySeparator: ' › ',
  defaultReporters: ['default'],
  failureTitleBullet: '  ● ',
  resultStatusSkipped: 'pending',
}

const counters = {
  added: 0,
  matched: 0,
  unmatched: 0,
  updated: 0,
  unchecked: 0,
  total: 0,
  filesAdded: 0,
  filesRemoved: 0,
  filesUnmatched: 0,
  filesUpdated: 0,
}

const passing: FileSpec[] = [{ path: 'a.test.ts', tests: [{ path: ['one'] }] }]

async function summaryText(snapshots?: SnapshotRunSummary): Promise<string> {
  const out = output()
  const bus = createReporterBus([defaultReporter({ stream: out, report: POLICY })])
  await playRun(bus, passing, snapshots === undefined ? {} : { snapshots })
  return out.text()
}

describe('the default reporter: snapshots', () => {
  test('prints Jest`s Snapshots line between the tests and the time, zero parts left out', async () => {
    const text = await summaryText({
      counters: { ...counters, added: 2, matched: 3, total: 5, filesAdded: 1 },
      uncheckedKeysByFile: [],
      update: 'new',
      files: [],
    })
    assert.match(
      text,
      /Tests: {7}1 passed, 1 total\nSnapshots: {3}2 written, 3 passed, 5 total\nTime:/,
    )
  })

  test('lists the obsolete snapshots by file above the totals, and counts them', async () => {
    const text = await summaryText({
      counters: { ...counters, matched: 1, unchecked: 2, total: 1 },
      uncheckedKeysByFile: [{ file: '/p/a.test.ts', keys: ['gone 1', 'also gone 1'] }],
      update: 'new',
      files: [],
    })
    assert.match(text, /2 snapshots obsolete from 1 test suite\. Run with -u to remove them\./)
    assert.match(text, / {2}↳ \/p\/a\.test\.ts\n {6}• gone 1\n {6}• also gone 1\n/)
    assert.match(text, /Snapshots: {3}2 obsolete, 1 passed, 1 total/)
  })

  test('says what to do in CI, where nothing may be written', async () => {
    const text = await summaryText({
      counters: { ...counters, unchecked: 1 },
      uncheckedKeysByFile: [{ file: 'a.test.ts', keys: ['x 1'] }],
      update: 'none',
      files: [],
    })
    assert.match(
      text,
      /1 snapshot obsolete from 1 test suite\. Run without --ci and with -u to remove it\./,
    )
  })

  test('counts failed and updated snapshots, and a removed file', async () => {
    const text = await summaryText({
      counters: { ...counters, unmatched: 1, updated: 2, filesRemoved: 1, total: 3 },
      uncheckedKeysByFile: [],
      update: 'all',
      files: [],
    })
    assert.match(text, /Snapshots: {3}1 failed, 1 file removed, 2 updated, 3 total/)
  })

  test('has no Snapshots line when no snapshot was checked', async () => {
    assert.doesNotMatch(await summaryText(), /Snapshots:/)
  })
})
