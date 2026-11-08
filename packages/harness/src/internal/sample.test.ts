import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HarnessError } from '../errors.ts'
import { type Fixture, readFixture } from '../fixture.ts'
import type { RecordPaths } from '../record.ts'
import { makeFile, makeRun, makeTest } from '../test-support.ts'
import { recordedEnv, rewritePaths, SAMPLE_DIR, sampleCopy, sampleRunProblems } from './sample.ts'

function fixture(files: readonly string[]): Fixture {
  return {
    dir: '/sample',
    id: 'sample',
    manifest: { description: 'd', runners: ['jest', 'vitest'] },
    files,
  }
}

test('a copy holds the shared files and its own half of a pair, named as one file key', () => {
  const files = [
    '__mocks__/greet.ts',
    '__recorded__/jest.raw.json',
    'a.test.ts',
    'exclusions.json',
    'greet.ts',
    'modules.jest.test.ts',
    'modules.vitest.test.ts',
  ]
  const jest = sampleCopy(fixture(files), 'jest')
  assert.deepEqual(
    [...jest.files],
    [
      ['__mocks__/greet.ts', '__mocks__/greet.ts'],
      ['a.test.ts', 'a.test.ts'],
      ['greet.ts', 'greet.ts'],
      ['modules.test.ts', 'modules.jest.test.ts'],
    ],
  )
  assert.deepEqual(jest.testFiles, ['a.test.ts', 'modules.test.ts'])
  const vitest = sampleCopy(fixture(files), 'vitest')
  assert.equal(vitest.files.get('modules.test.ts'), 'modules.vitest.test.ts')
  assert.deepEqual(vitest.testFiles, ['a.test.ts', 'modules.test.ts'])
})

test('a pair whose name a shared file already has is refused', () => {
  assert.throws(
    () => sampleCopy(fixture(['m.test.ts', 'm.jest.test.ts']), 'jest'),
    (error: unknown) => error instanceof HarnessError && error.code === 'HARNESS_SELF_TEST_FAILED',
  )
})

test('the real sample: 18 test files per runner, with modules.test.ts from the pair', async () => {
  const sample = await readFixture(SAMPLE_DIR)
  for (const dialect of ['jest', 'vitest'] as const) {
    const { testFiles } = sampleCopy(sample, dialect)
    assert.ok(testFiles.length >= 16, `${dialect}: ${testFiles.length}`)
    assert.ok(testFiles.includes('modules.test.ts'))
    assert.ok(!testFiles.some((file) => file.includes('.jest.') || file.includes('.vitest.')))
  }
  assert.deepEqual(sampleCopy(sample, 'jest').testFiles, sampleCopy(sample, 'vitest').testFiles)
})

test('a whole sample run has exactly the expected crash and nothing else wrong', () => {
  const files = ['a.test.ts', 'crash.test.ts']
  const good = makeRun([
    makeFile('a.test.ts', [makeTest('a.test.ts', ['t'])]),
    {
      file: 'crash.test.ts',
      status: 'crashed',
      fileError: { message: "Cannot find module './does-not-exist.ts'", raw: '' },
      tests: [],
    },
  ])
  assert.deepEqual(sampleRunProblems(good, files), [])
  const bad = makeRun(
    [
      { file: 'a.test.ts', status: 'crashed', tests: [] },
      { file: 'crash.test.ts', status: 'failed', tests: [] },
      makeFile('extra.test.ts', [makeTest('extra.test.ts', ['t'])]),
    ],
    { runErrors: [{ message: 'boom', raw: 'boom' }] },
  )
  assert.deepEqual(sampleRunProblems(bad, [...files, 'gone.test.ts']), [
    'gone.test.ts is missing from the run',
    'a.test.ts crashed: (no message)',
    'crash.test.ts did not crash (failed)',
    'extra.test.ts is not a sample test file',
    'run error: boom',
  ])
})

test('a recording keeps the runner version and the Node major, and no machine detail', () => {
  assert.deepEqual(recordedEnv('jest', '30.5.2', 'v24.22.1'), {
    os: 'unrecorded',
    osRelease: 'unrecorded',
    arch: 'unrecorded',
    cpuModel: 'unrecorded',
    cpuCount: 0,
    memoryMb: 0,
    node: 'v24',
    runners: { jest: '30.5.2' },
    ci: false,
  })
})

test("rewritePaths replaces this machine's directories, the deepest first", () => {
  const paths: RecordPaths = {
    workDir: '/home/me/repo/packages/harness/.record/self-test-jest-abc',
    realWorkDir: '/real/home/me/repo/packages/harness/.record/self-test-jest-abc',
    repoRoot: '/home/me/repo',
    packageDir: '/home/me/repo/packages/harness',
    realPackageDir: '/real/home/me/repo/packages/harness',
    home: '/home/me',
  }
  const text = [
    'at /home/me/repo/packages/harness/.record/self-test-jest-abc/a.test.ts:1:2',
    'at file:///real/home/me/repo/packages/harness/.record/self-test-jest-abc/b.ts:3:4',
    'at /home/me/repo/node_modules/.pnpm/jest/x.js:5:6',
    'at /real/home/me/repo/packages/harness/src/jest-transform.ts:7:8',
    'in /home/me/.cache/x',
  ].join('\n')
  assert.equal(
    rewritePaths(text, paths),
    [
      'at /__root__/a.test.ts:1:2',
      'at file:///__root__/b.ts:3:4',
      'at /__repo__/node_modules/.pnpm/jest/x.js:5:6',
      'at /__repo__/packages/harness/src/jest-transform.ts:7:8',
      'in /__home__/.cache/x',
    ].join('\n'),
  )
})
