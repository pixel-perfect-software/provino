import assert from 'node:assert/strict'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { convertJest, parseJestJson, readRunEnvironment } from '@provino/harness'
import type { NormalizedFile, NormalizedRun } from '@provino/types'
import { runCli } from './commands.ts'
import { scratch, scratchSuites } from './internal/test-helpers.ts'
import { checkStatusParity, parityLines } from './parity.ts'
import { DEFAULT_PATHS, parseSuiteName, suiteDir } from './suites.ts'

const spec = parseSuiteName('app-1')
const VERSIONS = { jest: '30.5.2', provino: '0.0.0' }

/** A test: its title and how many assertions passed in it. */
type Case = readonly [title: string, passingAsserts: number]

/** Jest's `--json` report for passing tests, in files named under `rootDir`. */
function jestReport(rootDir: string, files: Readonly<Record<string, readonly Case[]>>): string {
  return JSON.stringify({
    numFailedTestSuites: 0,
    numFailedTests: 0,
    numPassedTestSuites: Object.keys(files).length,
    numPassedTests: 0,
    numPendingTestSuites: 0,
    numPendingTests: 0,
    numRuntimeErrorTestSuites: 0,
    numTodoTests: 0,
    numTotalTestSuites: Object.keys(files).length,
    numTotalTests: 0,
    snapshot: {
      added: 0,
      didUpdate: false,
      failure: false,
      filesAdded: 0,
      filesRemoved: 0,
      filesRemovedList: [],
      filesUnmatched: 0,
      filesUpdated: 0,
      matched: 0,
      total: 0,
      unchecked: 0,
      uncheckedKeysByFile: [],
      unmatched: 0,
      updated: 0,
    },
    startTime: Date.UTC(2026, 10, 5),
    success: true,
    wasInterrupted: false,
    testResults: Object.entries(files).map(([name, cases]) => ({
      assertionResults: cases.map(([title, numPassingAsserts]) => ({
        ancestorTitles: ['suite'],
        failureMessages: [],
        fullName: `suite ${title}`,
        location: { line: 3, column: 3 },
        numPassingAsserts,
        status: 'passed',
        title,
      })),
      endTime: 2,
      message: '',
      name: join(rootDir, name),
      startTime: 1,
      status: 'passed',
      summary: '',
    })),
  })
}

const FILES: Readonly<Record<string, readonly Case[]>> = {
  'tests/a.test.js': [
    ['one', 1],
    ['two', 2],
  ],
  'tests/b.test.js': [
    ['three', 1],
    ['four', 1],
  ],
}

/**
 * A suite directory holding Jest's report for `FILES` and a Provino report made from the same
 * report, then changed by `change`: that is the only way the two can differ.
 */
async function reportsWith(
  t: Parameters<typeof scratch>[0],
  change: (run: NormalizedRun) => NormalizedRun | string,
): Promise<string> {
  const root = await scratch(t, 'bench-parity-')
  const dir = suiteDir(spec, root)
  await mkdir(join(dir, 'jest'), { recursive: true })
  await mkdir(join(dir, 'check'), { recursive: true })
  const rootDir = await realpath(join(dir, 'jest'))
  const jest = jestReport(rootDir, FILES)
  await writeFile(join(dir, 'check', 'jest.json'), jest)
  const converted = convertJest(parseJestJson(jest, 'jest.json'), {
    rootDir,
    suite: spec.name,
    runnerVersion: VERSIONS.jest,
    env: readRunEnvironment(VERSIONS),
  })
  const provino = change({ ...converted, runner: 'provino:jest', runnerVersion: VERSIONS.provino })
  await writeFile(
    join(dir, 'check', 'provino.json'),
    typeof provino === 'string' ? provino : JSON.stringify(provino),
  )
  return root
}

function mapFiles(
  run: NormalizedRun,
  change: (file: NormalizedFile) => NormalizedFile | undefined,
): NormalizedRun {
  return { ...run, files: run.files.flatMap((file) => change(file) ?? []) }
}

test('runs that agree on every status are at parity, with nothing to report', async (t) => {
  const root = await reportsWith(t, (run) => run)
  const parity = await checkStatusParity(spec, VERSIONS, {
    paths: { ...DEFAULT_PATHS, suitesRoot: root },
  })
  assert.equal(parity.ok, true)
  assert.equal(parity.unavailable, undefined)
  assert.deepEqual(
    [parity.statusMatched, parity.referenceTests, parity.candidateOnlyTests],
    [4, 4, 0],
  )
  assert.deepEqual([parity.filesMatched, parity.files], [2, 2])
  assert.deepEqual(parity.failing, [])
  assert.deepEqual(parity.assertionDiffs, [])
  assert.deepEqual(parityLines(parity), [
    'PASS status parity: 4/4 reference tests have the same status; 2/2 files; 0 candidate-only tests',
    'passing-assertion diffs: 0',
  ])
})

test('a test whose status differs fails the parity, and the first diffs are printed', async (t) => {
  const root = await reportsWith(t, (run) =>
    mapFiles(run, (file) => ({
      ...file,
      status: 'failed',
      tests: file.tests.map((test) => ({ ...test, status: 'failed' as const })),
    })),
  )
  const parity = await checkStatusParity(spec, VERSIONS, {
    paths: { ...DEFAULT_PATHS, suitesRoot: root },
  })
  assert.equal(parity.ok, false)
  assert.equal(parity.statusMatched, 0)
  // 4 tests and 2 files differ; 3 are shown
  assert.equal(parity.failing.filter((diff) => diff.kind === 'status').length, 4)
  assert.equal(parity.failing.filter((diff) => diff.kind === 'file-status').length, 2)
  const lines = parityLines(parity)
  assert.equal(
    lines[0],
    'FAIL status parity: 0/4 reference tests have the same status; 0/2 files; 0 candidate-only tests',
  )
  assert.equal(lines.length, 1 + 3 + 1 + 1)
  assert.match(lines[1] ?? '', /^ {2}tests\/a\.test\.js .* jest passed, provino failed$/)
  assert.equal(lines[4], '  ... and 3 more')
})

test('a test or file only one run has fails the parity, and Provino’s extras are counted', async (t) => {
  const root = await reportsWith(t, (run) => {
    const withExtra = mapFiles(run, (file) =>
      file.file === 'tests/a.test.js'
        ? {
            ...file,
            tests: [
              ...file.tests.slice(1),
              {
                ...(file.tests[0] as NormalizedFile['tests'][number]),
                id: { file: file.file, path: ['suite', 'extra'], dupIndex: 0 },
              },
            ],
          }
        : file.file === 'tests/b.test.js'
          ? undefined
          : file,
    )
    return withExtra
  })
  const parity = await checkStatusParity(spec, VERSIONS, {
    paths: { ...DEFAULT_PATHS, suitesRoot: root },
  })
  assert.equal(parity.ok, false)
  assert.equal(parity.candidateOnlyTests, 1)
  assert.deepEqual(
    new Set(parity.failing.map((diff) => diff.kind)),
    new Set(['missing-in-candidate', 'missing-in-reference', 'file-status']),
  )
  assert.match(
    parityLines(parity)[0] ?? '',
    /^FAIL status parity: 1\/4 .*; 1\/2 files; 1 candidate-only tests$/,
  )
})

test('a different count of passing assertions is reported but does not fail the parity', async (t) => {
  const root = await reportsWith(t, (run) =>
    mapFiles(run, (file) => ({
      ...file,
      tests: file.tests.map((test) =>
        test.id.path[1] === 'two' ? { ...test, passingAssertions: 5 } : test,
      ),
    })),
  )
  const parity = await checkStatusParity(spec, VERSIONS, {
    paths: { ...DEFAULT_PATHS, suitesRoot: root },
  })
  assert.equal(parity.ok, true)
  assert.equal(parity.statusMatched, 4)
  assert.deepEqual(parity.failing, [])
  assert.equal(parity.assertionDiffs.length, 1)
  assert.deepEqual(parity.assertionDiffs[0]?.kind, 'passing-assertions')
  const lines = parityLines(parity)
  assert.match(lines[0] ?? '', /^PASS status parity: 4\/4 /)
  assert.equal(
    lines[1],
    'passing-assertion diffs: 1 tests (reported, not a failure: the check is on statuses)',
  )
  assert.match(
    lines[2] ?? '',
    /^ {2}tests\/a\.test\.js::suite › two#0 passing-assertions: jest 2, provino 5$/,
  )
})

test('reports that cannot be compared fail the parity with the reason, not a crash', async (t) => {
  const root = await reportsWith(t, () => '{"schemaVersion": 1}')
  const parity = await checkStatusParity(spec, VERSIONS, {
    paths: { ...DEFAULT_PATHS, suitesRoot: root },
  })
  assert.equal(parity.ok, false)
  assert.match(parity.unavailable ?? '', /^HARNESS_RESULT_INVALID: /)
  assert.match(
    parityLines(parity).join('\n'),
    /^FAIL status parity: could not compare jest and provino: HARNESS_RESULT_INVALID/,
  )
  // a report that is not there at all is not the harness's to explain
  const empty = await scratch(t, 'bench-parity-')
  await assert.rejects(
    checkStatusParity(spec, VERSIONS, { paths: { ...DEFAULT_PATHS, suitesRoot: empty } }),
    { code: 'ENOENT' },
  )
})

test('check with jest and provino compares their statuses once both pass', async (t) => {
  const suitesRoot = await scratchSuites(t)
  const out: string[] = []
  const err: string[] = []
  const io = { out: (text: string) => out.push(text), err: (text: string) => err.push(text) }
  const paths = { ...DEFAULT_PATHS, suitesRoot }
  assert.equal(
    await runCli(['check', 'app-2', '--runner', 'jest', '--runner', 'provino'], io, { paths }),
    0,
    out.join('\n'),
  )
  const text = out.join('\n')
  assert.match(
    text,
    /^PASS jest 30\.5\.2 app-2: 16\/16 tests passed in [\d.]+ s \(local, one run: not a result\)$/m,
  )
  assert.match(
    text,
    /^PASS provino \S+ app-2: 16\/16 tests passed in [\d.]+ s \(local, one run: not a result\)$/m,
  )
  assert.match(text, /^ {2}maxWorkers [1-9]\d*: the default, \d+ cores - 1 and at least 1/m)
  assert.match(text, /^ {2}normalized-json: schema valid/m)
  assert.match(
    text,
    /^PASS status parity: 16\/16 reference tests have the same status; 2\/2 files; 0 candidate-only tests$/m,
  )
  assert.match(text, /^passing-assertion diffs: 0$/m)
})

test('check with provino alone does not compare anything', async (t) => {
  const suitesRoot = await scratchSuites(t)
  const out: string[] = []
  const io = { out: (text: string) => out.push(text), err: () => undefined }
  const paths = { ...DEFAULT_PATHS, suitesRoot }
  assert.equal(await runCli(['check', 'app-2', '--runner', 'provino'], io, { paths }), 0)
  assert.match(out.join('\n'), /^PASS provino /m)
  assert.doesNotMatch(out.join('\n'), /parity/)
})
