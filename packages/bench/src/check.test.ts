import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { parseNormalizedRun, readRunEnvironment, runProcess } from '@provino/harness'
import type { NormalizedFile, NormalizedRun, NormalizedTest } from '@provino/types'
import {
  checkProblems,
  checkRunner,
  failureDetails,
  type Report,
  readReport,
  summarize,
} from './check.ts'
import { commonFiles } from './generators/render.ts'
import { code, scratch, scratchSuites } from './internal/test-helpers.ts'
import {
  DEFAULT_PATHS,
  expectedTests,
  parseSuiteName,
  planRunner,
  suiteDir,
  writeSuite,
} from './suites.ts'

const passing: Report = {
  numTotalTests: 40,
  numPassedTests: 40,
  numFailedTests: 0,
  success: true,
  testResults: [],
}

test('the totals of a report are the ones the check judges', () => {
  assert.deepEqual(summarize(passing), { total: 40, passed: 40, failed: 0, success: true })
})

test('a clean run with the expected count has no problems', () => {
  assert.deepEqual(checkProblems(0, summarize(passing), 40), [])
})

test('every way a run can be wrong is named', () => {
  assert.deepEqual(checkProblems(1, summarize(passing), 40), ['exited 1'])
  assert.deepEqual(checkProblems(0, undefined, 40), ['wrote no readable JSON report'])
  assert.deepEqual(
    checkProblems(0, summarize({ ...passing, numTotalTests: 39, numPassedTests: 39 }), 40),
    ['ran 39 tests, expected 40', '39 tests passed, expected 40'],
  )
  assert.deepEqual(
    checkProblems(
      1,
      summarize({ ...passing, numFailedTests: 2, numPassedTests: 38, success: false }),
      40,
    ),
    ['exited 1', 'reported failure', '38 tests passed, expected 40', '2 tests failed'],
  )
  // skipped tests do not count as passed, so a suite that skips fails the check
  assert.deepEqual(checkProblems(0, summarize({ ...passing, numPassedTests: 39 }), 40), [
    '39 tests passed, expected 40',
  ])
})

test('failure details name the file, the test and the first line, without colour codes', () => {
  const report: Report = {
    ...passing,
    testResults: [
      { name: '/s/tests/a.test.js', status: 'passed', message: '', assertionResults: [] },
      {
        name: '/s/tests/b.test.js',
        status: 'failed',
        message: '',
        assertionResults: [
          { title: 'one', fullName: 'b one', status: 'passed', failureMessages: [] },
          {
            title: 'two',
            fullName: 'b two',
            status: 'failed',
            failureMessages: ['\u001b[31mExpected: 1\u001b[39m\nReceived: 2'],
          },
        ],
      },
      {
        name: '/s/tests/c.test.js',
        status: 'failed',
        message: '\nCannot find module x',
        assertionResults: [],
      },
    ],
  }
  assert.deepEqual(failureDetails(report), [
    '/s/tests/b.test.js > b two: Expected: 1',
    '/s/tests/c.test.js: Cannot find module x',
  ])
  assert.deepEqual(failureDetails(report, 1), ['/s/tests/b.test.js > b two: Expected: 1'])
})

test('a failed test with no message, or no full name, is still named', () => {
  const report: Report = {
    ...passing,
    testResults: [
      {
        name: '/s/tests/d.test.js',
        status: 'failed',
        message: '',
        assertionResults: [
          { title: 'bare', status: 'failed', failureMessages: null },
          { title: 'empty', fullName: 'd empty', status: 'failed', failureMessages: [null] },
        ],
      },
    ],
  }
  assert.deepEqual(failureDetails(report), [
    '/s/tests/d.test.js > bare: (no message)',
    '/s/tests/d.test.js > d empty: (no message)',
  ])
})

// The smallest envelope each runner's parser accepts. Jest's report also carries `wasInterrupted`;
// Vitest's carries `numTodoTests` and none of Jest's own fields.
const envelope = { ...passing, startTime: 0, snapshot: {} }
const jestReport = { ...envelope, wasInterrupted: false }
const vitestReport = { ...envelope, numTodoTests: 0 }

test('a report is read by the runner that wrote it', async (t) => {
  const dir = await scratch(t, 'bench-check-')
  await writeFile(join(dir, 'jest.json'), JSON.stringify(jestReport))
  await writeFile(join(dir, 'vitest.json'), JSON.stringify(vitestReport))
  const jest = await readReport('jest', join(dir, 'jest.json'))
  assert.ok(jest)
  assert.deepEqual(summarize(jest), { total: 40, passed: 40, failed: 0, success: true })
  const vitest = await readReport('vitest', join(dir, 'vitest.json'))
  assert.ok(vitest)
  assert.equal(vitest.numTotalTests, 40)
})

test('a report that is missing, broken or another runner’s reads as nothing', async (t) => {
  const dir = await scratch(t, 'bench-check-')
  await writeFile(join(dir, 'jest.json'), JSON.stringify(jestReport))
  await writeFile(join(dir, 'vitest.json'), JSON.stringify(vitestReport))
  await writeFile(join(dir, 'broken.json'), '{"numTotalTests": 4')
  await writeFile(join(dir, 'list.json'), '[]')
  assert.equal(await readReport('jest', join(dir, 'missing.json')), undefined)
  assert.equal(await readReport('jest', join(dir, 'broken.json')), undefined)
  assert.equal(await readReport('jest', join(dir, 'list.json')), undefined)
  assert.equal(await readReport('jest', join(dir, 'vitest.json')), undefined)
  assert.equal(await readReport('vitest', join(dir, 'jest.json')), undefined)
})

test('a report that cannot be read for another reason is an error, not a missing report', async (t) => {
  const dir = await scratch(t, 'bench-check-')
  await mkdir(join(dir, 'a-directory'))
  await assert.rejects(readReport('jest', join(dir, 'a-directory')), { code: 'EISDIR' })
})

test('a run past its timeout fails the check as exit 124 and names the timeout', async (t) => {
  const root = await scratch(t, 'bench-check-')
  const spec = parseSuiteName('app-1')
  await writeSuite(spec, root)
  // One millisecond is less than any runner needs to start, so the run is killed before it can
  // write a report.
  const result = await checkRunner(spec, 'jest', {
    paths: { ...DEFAULT_PATHS, suitesRoot: root },
    timeoutMs: 1,
  })
  assert.equal(result.ok, false)
  assert.equal(result.exitCode, 124)
  assert.equal(result.summary, undefined)
  assert.deepEqual(result.notes, [])
  assert.deepEqual(result.problems, [
    'exited 124',
    'wrote no readable JSON report',
    'timed out after 0.001 s and was killed',
  ])
  assert.ok(result.wallMs < 10_000, `wall ${result.wallMs} ms`)
})

test('a timeout outside what a timer can hold is refused before anything runs', async (t) => {
  const root = await scratch(t, 'bench-check-')
  for (const timeoutMs of [0, 1.5, Number.NaN, 2 ** 31]) {
    await assert.rejects(
      checkRunner(parseSuiteName('app-1'), 'jest', {
        paths: { ...DEFAULT_PATHS, suitesRoot: root },
        timeoutMs,
      }),
      code('BENCH_INVALID_SPEC'),
      String(timeoutMs),
    )
  }
})

function normalizedTest(
  file: string,
  title: string,
  status: NormalizedTest['status'],
  message?: string,
): NormalizedTest {
  return {
    id: { file, path: ['suite', title], dupIndex: 0 },
    status,
    errors: message === undefined ? [] : [{ message, raw: message }],
  }
}

function normalizedRun(files: readonly NormalizedFile[], success: boolean): NormalizedRun {
  return {
    schemaVersion: 1,
    runner: 'provino:jest',
    runnerVersion: '0.0.0',
    suite: 'jest',
    startedAt: '2026-11-05T00:00:00.000Z',
    env: readRunEnvironment({ provino: '0.0.0' }),
    files,
    runErrors: [],
    success,
  }
}

test('a Provino report is its normalized-json, read for the same totals and failures as the others', async (t) => {
  const dir = await scratch(t, 'bench-check-')
  const run = normalizedRun(
    [
      {
        file: 'tests/a.test.js',
        status: 'failed',
        tests: [
          normalizedTest('tests/a.test.js', 'one', 'passed'),
          normalizedTest('tests/a.test.js', 'two', 'failed', 'expected 1\nreceived 2'),
          normalizedTest('tests/a.test.js', 'three', 'skipped'),
        ],
      },
      {
        file: 'tests/b.test.js',
        status: 'crashed',
        fileError: { message: 'worker killed by SIGSEGV', raw: 'worker killed by SIGSEGV' },
        tests: [normalizedTest('tests/b.test.js', 'four', 'notRun')],
      },
    ],
    false,
  )
  await writeFile(join(dir, 'provino.json'), JSON.stringify(run))
  const report = await readReport('provino', join(dir, 'provino.json'))
  assert.ok(report)
  assert.deepEqual(summarize(report), { total: 4, passed: 1, failed: 1, success: false })
  assert.deepEqual(failureDetails(report), [
    'tests/a.test.js > suite two: expected 1',
    'tests/b.test.js: worker killed by SIGSEGV',
  ])
  // a skipped or never-run test is not a pass, so it cannot make up the expected count
  assert.deepEqual(checkProblems(0, summarize(report), 4), [
    'reported failure',
    '1 tests passed, expected 4',
    '1 tests failed',
  ])
})

test('a Provino report must be a NormalizedRun: another runner’s JSON, or a broken file, reads as nothing', async (t) => {
  const dir = await scratch(t, 'bench-check-')
  await writeFile(join(dir, 'jest.json'), JSON.stringify(jestReport))
  await writeFile(join(dir, 'wrong-version.json'), JSON.stringify({ schemaVersion: 2 }))
  assert.equal(await readReport('provino', join(dir, 'jest.json')), undefined)
  assert.equal(await readReport('provino', join(dir, 'wrong-version.json')), undefined)
  assert.equal(await readReport('provino', join(dir, 'missing.json')), undefined)
  // and a Provino report is not a Jest report
  const ok = normalizedRun([], true)
  await writeFile(join(dir, 'provino.json'), JSON.stringify(ok))
  assert.equal(await readReport('jest', join(dir, 'provino.json')), undefined)
})

test('Provino runs a generated suite as a black box and passes it, with its workers and schema noted', async (t) => {
  const root = await scratchSuites(t)
  const spec = parseSuiteName('app-2')
  await writeSuite(spec, root)
  const paths = { ...DEFAULT_PATHS, suitesRoot: root }
  const result = await checkRunner(spec, 'provino', { paths })
  assert.deepEqual(result.problems, [])
  assert.equal(result.ok, true)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.summary, { total: 16, passed: 16, failed: 0, success: true })
  assert.equal(result.notes.length, 2)
  assert.match(
    result.notes[0] ?? '',
    /^maxWorkers [1-9]\d*: the default, \d+ cores - 1 and at least 1/,
  )
  assert.match(result.notes[1] ?? '', /^normalized-json: schema valid/)
  // the JSON on disk is a NormalizedRun that the harness accepts
  const reportPath = join(suiteDir(spec, root), 'check', 'provino.json')
  const run = parseNormalizedRun(await readFile(reportPath, 'utf8'), reportPath)
  assert.equal(run.runner, 'provino:jest')
  assert.equal(run.files.length, 2)
})

test('a Provino run with a failing test fails the check and names the test', async (t) => {
  const root = await scratchSuites(t)
  const spec = parseSuiteName('app-2')
  await writeSuite(spec, root)
  await writeFile(
    join(suiteDir(spec, root), 'jest', 'tests', 'app-0000.test.js'),
    "describe('x', () => {\n  test('fails on purpose', () => {\n    throw new Error('on purpose')\n  })\n})\n",
  )
  const result = await checkRunner(spec, 'provino', {
    paths: { ...DEFAULT_PATHS, suitesRoot: root },
  })
  assert.equal(result.ok, false)
  assert.equal(result.exitCode, 1)
  assert.deepEqual(result.problems, [
    'exited 1',
    'reported failure',
    'ran 9 tests, expected 16',
    '8 tests passed, expected 16',
    '1 tests failed',
  ])
  assert.deepEqual(result.details, ['tests/app-0000.test.js > x fails on purpose: on purpose'])
})

// The kill-check's registry/none ratio means nothing if `provino.none.config.mjs` doesn't really
// run at `none`: the ratio would drift to about 1.0 and the check would pass for nothing. Two files
// require one module with a module-level counter and log what they see: one worker shares the
// module under `none` (1 and 2) and gives each file a fresh copy under `registry` (1 and 1).
test('the generated configs run Provino at the tier they state, through the real bin', async (t) => {
  const root = await scratchSuites(t)
  const spec = parseSuiteName('app-1')
  const dir = suiteDir(spec, root)
  const log = join(dir, 'seen.log')
  const files = [
    ...commonFiles(spec.name, 'cjs'),
    {
      path: 'jest/shared.js',
      contents: 'let calls = 0\nmodule.exports = () => ++calls\n',
    },
    ...['a', 'b'].map((name) => ({
      path: `jest/tests/${name}.test.js`,
      contents: [
        "const fs = require('node:fs')",
        "const next = require('../shared.js')",
        `test('${name}', () => {`,
        `  fs.appendFileSync(${JSON.stringify(log)}, next() + '\\n')`,
        '})',
        '',
      ].join('\n'),
    })),
  ]
  for (const file of files) {
    await mkdir(dirname(join(dir, file.path)), { recursive: true })
    await writeFile(join(dir, file.path), file.contents)
  }
  const paths = { ...DEFAULT_PATHS, suitesRoot: root }
  const seen = async (isolation: 'registry' | 'none'): Promise<string[]> => {
    await rm(log, { force: true })
    const plan = planRunner(spec, 'provino', { paths, isolation, extraArgs: ['--maxWorkers', '1'] })
    const [command, ...args] = plan.argv
    assert.ok(command)
    const exit = await runProcess(command, args, {
      cwd: plan.cwd,
      env: { ...process.env, ...plan.env },
      timeoutMs: 120_000,
    })
    assert.equal(exit.exitCode, 0, `${isolation}: ${exit.output}`)
    return (await readFile(log, 'utf8')).trim().split('\n').sort()
  }
  assert.deepEqual(await seen('none'), ['1', '2'])
  assert.deepEqual(await seen('registry'), ['1', '1'])
})

// D19, as behaviour: a timed Provino run is passed no --no-cache. The results cache it keeps only
// orders the next run's files (durations, last status); it never skips one, so a second run with
// the cache present still reports every test.
test('with the results cache kept, a second Provino run still runs and reports every test (D19)', async (t) => {
  const root = await scratchSuites(t)
  const spec = parseSuiteName('app-2')
  await writeSuite(spec, root)
  const paths = { ...DEFAULT_PATHS, suitesRoot: root }
  const reportPath = join(suiteDir(spec, root), 'check', 'timed.json')
  const plan = planRunner(spec, 'provino', {
    paths,
    extraArgs: ['--reporter', 'normalized-json', '--outputFile', reportPath],
  })
  assert.ok(!plan.argv.includes('--no-cache'))
  const [command, ...args] = plan.argv
  assert.ok(command)
  const cache = plan.caches.find((entry) => entry.kind === 'provino')
  assert.ok(cache)

  // The `at` of every file in the results cache, by file path.
  const stamps = async (): Promise<Map<string, number>> => {
    const data: unknown = JSON.parse(await readFile(join(cache.path, 'results.json'), 'utf8'))
    const found = new Map<string, number>()
    const { projects } = data as { projects: Record<string, Record<string, { at: number }>> }
    for (const files of Object.values(projects)) {
      for (const [path, history] of Object.entries(files)) found.set(path, history.at)
    }
    return found
  }

  const seen: Map<string, number>[] = []
  for (const run of [1, 2]) {
    // A stale report from the run before must not be what is read.
    await rm(reportPath, { force: true })
    const exit = await runProcess(command, args, {
      cwd: plan.cwd,
      env: { ...process.env, ...plan.env },
      timeoutMs: 120_000,
    })
    assert.equal(exit.exitCode, 0, `run ${run}: ${exit.output}`)
    const report = parseNormalizedRun(await readFile(reportPath, 'utf8'), reportPath)
    const tests = report.files.flatMap((file) => file.tests)
    assert.equal(tests.length, expectedTests(spec), `run ${run} reports every test`)
    assert.ok(tests.every((test) => test.status === 'passed'))
    seen.push(await stamps())
  }
  // Every file ran again, not replayed: `cache.record` stamps `at` only for a file that ran.
  const [first, second] = seen
  assert.ok(first && second)
  assert.equal(first.size, spec.files, 'the cache holds every file')
  for (const [path, at] of first) {
    const later = second.get(path)
    assert.ok(later !== undefined && later > at, `${path} ran again (at ${at} then ${later})`)
  }
})
