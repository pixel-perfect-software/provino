// `exitCodeFor`: which code a finished run exits with, and in what order the reasons are tried.
import assert from 'node:assert/strict'
import { constants } from 'node:os'
import { describe, it } from 'node:test'
import { neutralPolicy, resolvePolicy } from '@provino/policy'
import type { FileResult, Policy, RunSummary } from '@provino/types'
import { ExitCode, exitCodeFor, isRunSignal, RUN_SIGNALS } from './exit-code.ts'

const policy: Policy = resolvePolicy({
  orchestrator: { exitCodes: { failure: 7, noTests: 8, unhandled: 9 } },
})

function file(state: FileResult['state']): FileResult {
  return {
    file: { fileId: 'f' as FileResult['file']['fileId'], path: 'a.test.ts', project: '' },
    state,
    durationMs: 1,
    errors: [],
  }
}

function summary(parts: Partial<RunSummary> = {}): RunSummary {
  return { reason: 'passed', files: [file('pass')], unhandled: [], durationMs: 1, ...parts }
}

describe('ExitCode', () => {
  it('has Track 9’s codes', () => {
    assert.deepEqual(ExitCode, {
      Pass: 0,
      TestFailure: 1,
      UsageError: 2,
      Sighup: 129,
      Sigint: 130,
      Sigterm: 143,
    })
  })
})

describe('RUN_SIGNALS', () => {
  it('is the one table: each signal’s exit code is 128 plus its number', () => {
    for (const [name, { exitCode }] of Object.entries(RUN_SIGNALS)) {
      assert.equal(exitCode, 128 + constants.signals[name as keyof typeof constants.signals], name)
    }
    assert.deepEqual(Object.keys(RUN_SIGNALS), ['SIGINT', 'SIGTERM', 'SIGHUP'])
  })

  it('names a run’s reason for each signal, and no two signals share one', () => {
    const reasons = Object.values(RUN_SIGNALS).map((entry) => entry.reason)
    assert.deepEqual(reasons, ['interrupted', 'terminated', 'hangup'])
    assert.equal(new Set(reasons).size, reasons.length)
  })

  it('tells a signal’s name from any other value, inherited keys included', () => {
    for (const name of Object.keys(RUN_SIGNALS)) assert.equal(isRunSignal(name), true, name)
    for (const other of [
      'SIGUSR1',
      'sigint',
      'toString',
      '__proto__',
      '',
      undefined,
      null,
      2,
      {},
    ]) {
      assert.equal(isRunSignal(other), false, String(other))
    }
  })
})

describe('exitCodeFor', () => {
  it('is 0 for a passing run, and for one that only skipped', () => {
    assert.equal(exitCodeFor(summary(), { policy }), 0)
    assert.equal(exitCodeFor(summary({ files: [file('skip')] }), { policy }), 0)
  })

  it('is the policy’s failure code when a file failed', () => {
    assert.equal(
      exitCodeFor(summary({ reason: 'failed', files: [file('pass'), file('fail')] }), { policy }),
      7,
    )
  })

  it('is the policy’s no-tests code when no file ran, unless passWithNoTests', () => {
    const none = summary({ files: [] })
    assert.equal(exitCodeFor(none, { policy }), 8)
    assert.equal(exitCodeFor(none, { policy, passWithNoTests: true }), 0)
    assert.equal(exitCodeFor(none, { policy, passWithNoTests: false }), 8)
  })

  it('takes passWithNoTests from the policy when the option is absent', () => {
    const lenient = resolvePolicy({ orchestrator: { passWithNoTests: true } })
    assert.equal(exitCodeFor(summary({ files: [] }), { policy: lenient }), 0)
    assert.equal(
      exitCodeFor(summary({ files: [] }), { policy: lenient, passWithNoTests: false }),
      1,
    )
  })

  it('is the policy’s failure code when the run’s coverage missed a threshold, ahead of an unhandled error', () => {
    const totals = { total: 1, covered: 1, pct: 100 }
    const coverage = {
      totals: { statements: totals, branches: totals, functions: totals, lines: totals },
      thresholdFailures: ['missed'],
      map: {},
    }
    assert.equal(exitCodeFor(summary({ coverage }), { policy }), 7)
    const withUnhandled = summary({ coverage, unhandled: [{ name: 'Error', message: 'x' }] })
    assert.equal(exitCodeFor(withUnhandled, { policy }), 7)
    assert.equal(
      exitCodeFor(summary({ coverage: { ...coverage, thresholdFailures: [] } }), { policy }),
      0,
    )
  })

  it('is the policy’s unhandled code for an unhandled error under fail-run', () => {
    const run = summary({ reason: 'failed', unhandled: [{ name: 'Error', message: 'x' }] })
    assert.equal(exitCodeFor(run, { policy }), 9)
  })

  it('ignores unhandled errors when the policy says ignore', () => {
    const lenient = resolvePolicy({ orchestrator: { unhandledErrors: 'ignore' } })
    const run = summary({ unhandled: [{ name: 'Error', message: 'x' }] })
    assert.equal(exitCodeFor(run, { policy: lenient }), 0)
  })

  it('fails a passing run whose reporter failed', () => {
    assert.equal(exitCodeFor(summary(), { policy, reporterFailures: [new Error('x')] }), 7)
    assert.equal(exitCodeFor(summary(), { policy, reporterFailures: [] }), 0)
  })

  it('prefers a failed file to an unhandled error, and an unhandled error to a reporter failure', () => {
    const both = summary({ files: [file('fail')], unhandled: [{ name: 'Error', message: 'x' }] })
    assert.equal(exitCodeFor(both, { policy, reporterFailures: [1] }), 7)
    const unhandledOnly = summary({ unhandled: [{ name: 'Error', message: 'x' }] })
    assert.equal(exitCodeFor(unhandledOnly, { policy, reporterFailures: [1] }), 9)
  })

  it('is the signal’s code for a run a signal ended, whatever else is true', () => {
    for (const { reason, exitCode } of Object.values(RUN_SIGNALS)) {
      const run = summary({ reason, files: [file('fail')] })
      assert.equal(exitCodeFor(run, { policy }), exitCode, reason)
      assert.equal(exitCodeFor(summary({ reason, files: [] }), { policy }), exitCode, reason)
    }
    // The codes themselves, written out once: 130 for Ctrl+C, 143 for SIGTERM, 129 for SIGHUP.
    assert.deepEqual(
      Object.values(RUN_SIGNALS).map((entry) => entry.exitCode),
      [130, 143, 129],
    )
  })

  it('uses the neutral policy’s codes when nothing overrides them', () => {
    assert.equal(
      exitCodeFor(summary({ files: [file('fail')] }), { policy: neutralPolicy }),
      neutralPolicy.orchestrator.exitCodes.failure,
    )
  })
})
