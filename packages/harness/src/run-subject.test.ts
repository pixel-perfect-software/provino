import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { HarnessError } from './errors.ts'
import { runSubject, subjectArgs } from './run-subject.ts'
import { sidecarReporterPath } from './sidecar.ts'

const FILES = { raw: '/out/jest.raw.json', sidecar: '/out/jest.console.jsonl' }
const RECORDED_JEST = path.join(
  import.meta.dirname,
  '..',
  'sample',
  '__recorded__',
  'jest.raw.json',
)

test("Jest's flags go after the caller's, so --reporters can't take a test path", () => {
  assert.deepEqual(subjectArgs('jest', ['--ci', 'src/a.test.ts'], FILES), [
    '--ci',
    'src/a.test.ts',
    '--json',
    '--outputFile=/out/jest.raw.json',
    '--testLocationInResults',
    '--silent=false',
    '--verbose=false',
    '--reporters=default',
    `--reporters=${sidecarReporterPath('jest')}`,
  ])
})

test('a single-file Jest subject is never verbose, so its console stays buffered for the sidecar', () => {
  // `@jest/core` turns verbose on for exactly one test file unless --verbose=false is given.
  const args = subjectArgs('jest', ['--ci', 'src/only.test.ts'], FILES)
  assert.ok(args.includes('--verbose=false'), args.join(' '))
  assert.ok(
    args.indexOf('--verbose=false') > args.indexOf('src/only.test.ts'),
    "after the caller's test path",
  )
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

test("an earlier run's JSON in a reused outDir is not read as this run's", async () => {
  // A stand-in `jest` that exits 1 without writing anything, as a run that crashes before its
  // reporter does. Written at test time, so no `.js` is committed (D13).
  const dir = await mkdtemp(path.join(tmpdir(), 'provino-run-subject-'))
  try {
    const pkg = path.join(dir, 'node_modules', 'jest')
    await mkdir(pkg, { recursive: true })
    await writeFile(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: 'jest', version: '0.0.0-stand-in', bin: { jest: 'bin.cjs' } }),
    )
    await writeFile(path.join(pkg, 'bin.cjs'), 'process.exitCode = 1\n')
    const outDir = path.join(dir, 'out')
    await mkdir(outDir)
    // The leftovers of a run that did finish: a valid Jest JSON and an empty sidecar.
    await copyFile(RECORDED_JEST, path.join(outDir, 'jest.raw.json'))
    await writeFile(path.join(outDir, 'jest.console.jsonl'), '')
    await assert.rejects(
      runSubject({
        runner: 'jest',
        cwd: dir,
        rootDir: dir,
        argv: [],
        env: process.env,
        suite: 's',
        outDir,
        timeoutMs: 30_000,
      }),
      (error: unknown) =>
        error instanceof HarnessError &&
        error.code === 'HARNESS_RUNNER_FAILED' &&
        error.message.includes('wrote no JSON'),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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
