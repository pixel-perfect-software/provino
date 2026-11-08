import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HarnessError } from './errors.ts'
import { runSubject, subjectArgs } from './run-subject.ts'
import { sidecarReporterPath } from './sidecar.ts'

const FILES = { raw: '/out/jest.raw.json', sidecar: '/out/jest.console.jsonl' }

test("Jest's flags go after the caller's, so --reporters can't take a test path", () => {
  assert.deepEqual(subjectArgs('jest', ['--ci', 'src/a.test.ts'], FILES), [
    '--ci',
    'src/a.test.ts',
    '--json',
    '--outputFile=/out/jest.raw.json',
    '--testLocationInResults',
    '--silent=false',
    '--reporters=default',
    `--reporters=${sidecarReporterPath('jest')}`,
  ])
})

test('Vitest gets its JSON reporter and the sidecar by path', () => {
  assert.deepEqual(subjectArgs('vitest', ['run'], FILES), [
    'run',
    '--reporter=json',
    '--outputFile.json=/out/jest.raw.json',
    `--reporter=${sidecarReporterPath('vitest')}`,
  ])
})

test('Provino writes normalized-json itself and has no sidecar', () => {
  assert.deepEqual(subjectArgs('provino', ['run', '--config', 'p.ts'], FILES), [
    'run',
    '--config',
    'p.ts',
    '--reporter',
    'normalized-json',
    '--outputFile',
    '/out/jest.raw.json',
  ])
})

test('a runner that is not installed where it is resolved from is HARNESS_RUNNER_FAILED', async () => {
  await assert.rejects(
    runSubject({
      runner: 'jest',
      cwd: '/',
      rootDir: '/',
      argv: [],
      env: {},
      suite: 's',
      outDir: '/nonexistent-out',
      from: '/',
    }),
    (error: unknown) => error instanceof HarnessError && error.code === 'HARNESS_RUNNER_FAILED',
  )
})
