// `exitCodeFor`: which code a finished run exits with, and in what order the reasons are tried.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { neutralPolicy, resolvePolicy } from '@provino/policy'
import type { FileResult, Policy, RunSummary } from '@provino/types'
import { ExitCode, exitCodeFor } from './exit-code.ts'

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
      Sigint: 130,
      Sigterm: 143,
    })
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

  it('is 130 for an interrupted run, whatever else is true', () => {
    const run = summary({ reason: 'interrupted', files: [file('fail')] })
    assert.equal(exitCodeFor(run, { policy }), ExitCode.Sigint)
    assert.equal(exitCodeFor(summary({ reason: 'interrupted', files: [] }), { policy }), 130)
  })

  it('uses the neutral policy’s codes when nothing overrides them', () => {
    assert.equal(
      exitCodeFor(summary({ files: [file('fail')] }), { policy: neutralPolicy }),
      neutralPolicy.orchestrator.exitCodes.failure,
    )
  })
})
