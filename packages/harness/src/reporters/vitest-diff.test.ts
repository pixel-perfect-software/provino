// The diff reporter on plain objects shaped like Vitest's reported tasks: a failed test's errors'
// diffs, `null` for an error with none, the converters' `dupIndex`, and nothing for a test that
// passed.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import VitestDiffReporter, { DIFF_ENV, type DiffEntry } from './vitest-diff.ts'

let dir = ''
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'provino-vitest-diff-'))
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('one line per failed test, its diffs in order, the same-named test counted', async () => {
  const file = path.join(dir, 'diffs.jsonl')
  const previous = process.env[DIFF_ENV]
  process.env[DIFF_ENV] = file
  try {
    const reporter = new VitestDiffReporter()
    type Test = Parameters<VitestDiffReporter['onTestCaseResult']>[0]
    const tests: Test[] = []
    const module = {
      type: 'module' as const,
      id: 'm',
      moduleId: '/work/a.test.ts',
      children: { allTests: () => tests },
    }
    const suite = { type: 'suite' as const, name: 'group', parent: module }
    const make = (id: string, state: string, errors: object[]): Test => {
      const made: Test = {
        type: 'test',
        id,
        name: 'same',
        module,
        parent: suite,
        result: () => ({ state, errors }),
      }
      tests.push(made)
      return made
    }
    const first = make('t1', 'passed', [])
    const second = make('t2', 'failed', [{ diff: '- a\n+ b' }, { message: 'no diff' }])
    reporter.onTestCaseResult(first)
    reporter.onTestCaseResult(second)
    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    const entries = lines.map((line) => JSON.parse(line) as DiffEntry)
    assert.deepEqual(entries, [
      { file: '/work/a.test.ts', path: ['group', 'same'], dupIndex: 1, diffs: ['- a\n+ b', null] },
    ])
  } finally {
    if (previous === undefined) delete process.env[DIFF_ENV]
    else process.env[DIFF_ENV] = previous
  }
})
