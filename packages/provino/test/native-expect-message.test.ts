// A native project's `expect(value, message)`: the message labels the assertion and shows first on a
// failure, with the matcher's own text (and the measured values) after it. Through the source bin.
import { describe, expect, test } from 'provino'
import { nativeProject, nativeRunArgs, outcomesByFile, spawnCli } from './support.ts'

const PASSING: Readonly<Record<string, string>> = {
  'tests/label.test.ts': [
    "import { expect, test } from 'provino'",
    "test('labels an assertion', () => { expect(4.6, 'ink on the card').toBeGreaterThanOrEqual(3) })",
    "test('labels a soft assertion', () => { expect.soft(4.6, 'ink on the card').toBeGreaterThan(3) })",
    '',
  ].join('\n'),
}

const FAILING: Readonly<Record<string, string>> = {
  'tests/label.test.ts': [
    "import { expect, test } from 'provino'",
    "test('labels a failure', () => { expect(2.1, 'ink on the card').toBeGreaterThanOrEqual(3) })",
    '',
  ].join('\n'),
  'tests/third.test.ts': [
    "import { expect, test } from 'provino'",
    "test('a third argument', () => { (expect as (...a: unknown[]) => unknown)(1, 'a', 'b') })",
    '',
  ].join('\n'),
}

// The default reporter's stderr carries the failures, which `nativeRunArgs` doesn't leave on.
const RUN_ARGS = ['run', '--config', 'provino.config.mjs', '--pool', 'forks', '--maxWorkers', '1']

describe('expect(value, message) in a native project', () => {
  test('a labelled assertion that holds passes', async () => {
    const dir = await nativeProject(PASSING)
    const ran = await spawnCli(nativeRunArgs('forks'), { cwd: dir })
    expect((await outcomesByFile(dir)).get('label.test.ts')).toBe('passed,passed')
    expect(ran.code).toBe(0)
  })

  test('a failure prints the message first, then the matcher text; a third argument is refused', async () => {
    const dir = await nativeProject(FAILING)
    const ran = await spawnCli(RUN_ARGS, { cwd: dir })
    expect(ran.code).toBe(1)
    expect(ran.stderr).toMatch(
      /ink on the card\s*\n\s*\n\s*expect\(received\)\.toBeGreaterThanOrEqual\(expected\)/,
    )
    expect(ran.stderr).toContain('2.1')
    expect(ran.stderr).toContain('expect() takes a value and an optional message')
  })
})
