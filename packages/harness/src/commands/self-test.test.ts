// self-test's own reporting, with a stand-in for the runners: no runner starts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HarnessError } from '../errors.ts'
import { parseCommandLine } from '../internal/cli-args.ts'
import { provinoParityProblems, type SampleRunner, selfTestCommand } from './self-test.ts'

async function selfTest(
  args: readonly string[],
  run: SampleRunner,
): Promise<{ code: number; out: string }> {
  const command = parseCommandLine(['self-test', ...args])
  if (command.command !== 'self-test') throw new Error('not a self-test command')
  let out = ''
  const code = await selfTestCommand(
    command,
    {
      out: (text) => {
        out += text
      },
      err: () => undefined,
    },
    run,
  )
  return { code, out }
}

test("a runner that fails is its check's FAIL line; the other checks still print, and it exits 1", async () => {
  const runners: string[] = []
  const failing: SampleRunner = async (_fixture, runner) => {
    runners.push(runner)
    throw new HarnessError('HARNESS_RUNNER_FAILED', `${runner} timed out after 120000 ms`)
  }
  const { code, out } = await selfTest(['--candidate', 'provino'], failing)
  assert.equal(code, 1)
  assert.deepEqual(runners, ['jest', 'vitest'], 'Vitest still runs after Jest fails')
  const lines = out.split('\n').filter((line) => /^(ok|FAIL)/.test(line))
  assert.deepEqual(lines, [
    'FAIL jest ran the whole sample',
    'FAIL vitest ran the whole sample',
    'FAIL calibrated parity is 100% with exactly the 4 sample rules',
    'FAIL provino:jest ran the sample, wrote a valid normalized-json and met the status parity bar',
  ])
  assert.match(out, /HARNESS_RUNNER_FAILED: jest timed out after 120000 ms/)
  assert.match(out, /HARNESS_RUNNER_FAILED: vitest timed out after 120000 ms/)
})

test('an error that is not a harness error is a bug, and is thrown', async () => {
  const buggy: SampleRunner = async () => {
    throw new TypeError('a bug')
  }
  await assert.rejects(selfTest([], buggy), TypeError)
})

test('the Provino status parity bar is the share measured on B17d: 84 of 88, and no number in the text', () => {
  assert.deepEqual(provinoParityProblems(84 / 88), [])
  assert.deepEqual(provinoParityProblems(1), [])
  const [problem] = provinoParityProblems(83 / 88)
  assert.match(problem ?? '', /below the bar/)
  assert.doesNotMatch(problem ?? '', /\d+%|\b84\b|\b88\b|0\.\d/)
  assert.equal(provinoParityProblems(0).length, 1)
})
