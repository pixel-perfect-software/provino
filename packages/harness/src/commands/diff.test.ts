// `provino-harness diff` on the sample's recorded runs (no runner starts). The exit codes are
// checked on the CLI as a child process; what goes to which stream, in process with a collector,
// because `runProcess` merges the two.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import type { ParityReport } from '../diff.ts'
import { parseCommandLine } from '../internal/cli-args.ts'
import { runProcess } from '../run-process.ts'
import { makeFile, makeRun, makeTest } from '../test-support.ts'
import { diffCommand } from './diff.ts'

const PACKAGE_DIR = path.resolve(import.meta.dirname, '..', '..')
const CLI = path.join(PACKAGE_DIR, 'src', 'cli.ts')
const RECORDED = path.join(PACKAGE_DIR, 'sample', '__recorded__')
const JEST = path.join(RECORDED, 'jest.normalized.json')
const VITEST = path.join(RECORDED, 'vitest.normalized.json')
const TODAY = '2026-11-07'

let dir = ''
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'provino-harness-diff-'))
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** The CLI as a child process, in its own process group with a deadline. */
async function cli(...args: string[]): Promise<{ code: number | null; output: string }> {
  const result = await runProcess(
    process.execPath,
    ['--conditions=provino-source', CLI, 'diff', ...args],
    { cwd: PACKAGE_DIR, env: process.env, timeoutMs: 60_000, tailChars: 1_000_000 },
  )
  assert.equal(result.timedOut, false)
  return { code: result.exitCode, output: result.output }
}

/** The command in process: its exit code, stdout and stderr apart. */
async function inProcess(
  ...args: string[]
): Promise<{ code: number; report: ParityReport | undefined; stderr: string }> {
  const command = parseCommandLine(['diff', ...args])
  assert.equal(command.command, 'diff')
  if (command.command !== 'diff') throw new Error('unreachable')
  let stdout = ''
  let stderr = ''
  const code = await diffCommand(command, {
    out: (text) => {
      stdout += text
    },
    err: (text) => {
      stderr += text
    },
  })
  const report = stdout === '' ? undefined : (JSON.parse(stdout) as ParityReport)
  return { code, report, stderr }
}

test('without exclusions, --min 1 exits 1 and --min 0.5 exits 0 (the CLI)', async () => {
  const strict = await cli('--ref', JEST, '--cand', VITEST, '--mode', 'matcher', '--min', '1')
  assert.equal(strict.code, 1)
  assert.match(strict.output, /status parity .* is below --min 1/)
  const lenient = await cli('--ref', JEST, '--cand', VITEST, '--mode', 'matcher', '--min', '0.5')
  assert.equal(lenient.code, 0)
  assert.match(lenient.output, /^PASS$/m)
})

test('bad usage or an unreadable run exits 2 (the CLI)', async () => {
  const usage = await cli('--ref', JEST)
  assert.equal(usage.code, 2)
  assert.match(usage.output, /--cand is required/)
  const missing = await cli('--ref', JEST, '--cand', path.join(dir, 'nope.json'))
  assert.equal(missing.code, 2)
  assert.match(missing.output, /can't read the candidate run/)
  const invalid = path.join(dir, 'invalid.json')
  await writeFile(invalid, '{"schemaVersion":1}')
  const unreadable = await cli('--ref', JEST, '--cand', invalid)
  assert.equal(unreadable.code, 2)
  assert.match(unreadable.output, /HARNESS_RESULT_INVALID/)
})

test('the ParityReport goes to stdout as JSON, the summary table to stderr', async () => {
  const outcome = await inProcess('--ref', JEST, '--cand', VITEST, '--min', '0', '--console')
  assert.equal(outcome.code, 0)
  const report = outcome.report
  assert.ok(report !== undefined)
  assert.equal(report.messageMode, 'exact')
  assert.deepEqual(report.reference, {
    runner: 'jest',
    runnerVersion: '30.5.2',
    suite: 'harness/sample',
  })
  assert.equal(report.candidate.runner, 'vitest')
  assert.ok(report.counts.referenceTests >= 63)
  for (const label of ['status parity', 'message parity', 'snapshot parity', 'suite pass']) {
    assert.match(outcome.stderr, new RegExp(`^${label} `, 'm'), label)
  }
  assert.doesNotMatch(outcome.stderr, /"statusParity"/, 'the JSON is not on stderr')
})

test('--max-diffs fails a run with more unexplained diffs than it allows', async () => {
  const outcome = await inProcess('--ref', JEST, '--cand', VITEST, '--min', '0', '--max-diffs', '0')
  assert.equal(outcome.code, 1)
  assert.match(outcome.stderr, /diffs no rule explains, more than --max-diffs 0/)
})

test('an empty comparison fails: no vacuous 1.0', async () => {
  const empty = path.join(dir, 'empty.json')
  await writeFile(empty, JSON.stringify(makeRun([])))
  const outcome = await inProcess('--ref', empty, '--cand', empty)
  assert.equal(outcome.code, 1)
  assert.match(outcome.stderr, /HARNESS_EMPTY_COMPARISON/)
  assert.equal(outcome.report?.statusParity, 1)
})

test('R2: exclusions must expire within 90 days, and may remove at most --max-excluded of T', async () => {
  const tests = Array.from({ length: 10 }, (_, i) => makeTest('a.test.ts', [`t${i}`]))
  const ref = path.join(dir, 'ref.json')
  const cand = path.join(dir, 'cand.json')
  await writeFile(ref, JSON.stringify(makeRun([makeFile('a.test.ts', tests)])))
  const changed = tests.map((t, i) => (i === 0 ? { ...t, status: 'skipped' as const } : t))
  await writeFile(cand, JSON.stringify(makeRun([makeFile('a.test.ts', changed)])))
  const rules = path.join(dir, 'rules.json')
  const rule = { id: 'div/t0', reason: 'r', kinds: ['status'], keyGlob: 'a.test.ts::t0#0' }
  const base = ['--ref', ref, '--cand', cand, '--exclusions', rules, '--today', TODAY]
  await writeFile(rules, JSON.stringify({ rules: [{ ...rule, expires: '2026-12-01' }] }))
  const capped = await inProcess(...base)
  assert.equal(capped.code, 1, '1 of 10 is over the 2% cap')
  assert.match(capped.stderr, /remove 1 of 10 reference tests, more than --max-excluded 0.02/)
  assert.equal((await inProcess(...base, '--max-excluded', '0.1')).code, 0)
  await writeFile(rules, JSON.stringify({ rules: [rule] }))
  const undated = await inProcess(...base)
  assert.equal(undated.code, 2)
  assert.match(undated.stderr, /HARNESS_EXCLUSIONS_INVALID: .*no "expires"/)
  assert.equal((await inProcess(...base, '--calibration')).code, 0, '--calibration lifts both')
})

test('a flaky list leaves its tests out of T', async () => {
  const ref = path.join(dir, 'flaky-ref.json')
  const cand = path.join(dir, 'flaky-cand.json')
  const file = (x: 'passed' | 'skipped') =>
    makeFile('a.test.ts', [
      makeTest('a.test.ts', ['x'], { status: x }),
      makeTest('a.test.ts', ['y']),
    ])
  await writeFile(ref, JSON.stringify(makeRun([file('passed')])))
  await writeFile(cand, JSON.stringify(makeRun([file('skipped')])))
  const flaky = path.join(dir, 'flaky.json')
  await writeFile(flaky, JSON.stringify({ keys: ['a.test.ts::x#0'] }))
  const outcome = await inProcess('--ref', ref, '--cand', cand, '--flaky', flaky)
  assert.equal(outcome.code, 0)
  assert.equal(outcome.report?.counts.flaky, 1)
  assert.equal(outcome.report?.counts.comparedTests, 1)
})
