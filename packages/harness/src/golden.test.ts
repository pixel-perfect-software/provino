import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NormalizedRun } from '@provino/types'
import { HarnessError } from './errors.ts'
import { goldenPath, serializeGolden, toGolden } from './golden.ts'
import { observedOf } from './record.ts'
import { makeFile, makeRun, makeTest } from './test-support.ts'

test('observed comes last, with its keys in a fixed order whatever the caller gave', () => {
  const golden = toGolden(makeRun([]), {
    observed: { files: { 'a.snap': null }, stderr: 'e', exitCode: 1 },
  })
  assert.deepEqual(Object.keys(golden).at(-1), 'observed')
  assert.deepEqual(Object.keys(golden.observed ?? {}), ['exitCode', 'stderr', 'files'])
  assert.equal('observed' in toGolden(makeRun([])), false)
})

test('observedOf keeps the captured kinds, filters and sorts the streams, and normalizes', () => {
  const normalize = (text: string): string => text.replaceAll('/work', '<root>')
  const observed = observedOf(
    {
      capture: ['stderr', 'exitCode', 'file:a.snap', 'file:gone.snap'],
      keepLines: '^K',
      sortStdout: true,
    },
    { exitCode: 1, stdout: 'not kept', stderr: 'K2 /work\nnoise\nK1' },
    { 'a.snap': 'at /work/a', 'gone.snap': null },
    normalize,
    'fixture.json',
  )
  assert.deepEqual(observed, {
    exitCode: 1,
    stderr: 'K1\nK2 <root>',
    files: { 'a.snap': 'at <root>/a', 'gone.snap': null },
  })
})

test('a stream keepLines keeps no line of is a broken run, unless emptyStreams lists it', () => {
  const result = { exitCode: 0, stdout: 'noise', stderr: 'K1' }
  const observe = (emptyStreams?: readonly ('stdout' | 'stderr')[]) =>
    observedOf(
      {
        capture: ['stdout', 'stderr'],
        keepLines: '^K',
        ...(emptyStreams === undefined ? {} : { emptyStreams }),
      },
      result,
      {},
      (text) => text,
      'fixture.json',
    )
  assert.throws(
    () => observe(),
    (error: unknown) =>
      error instanceof HarnessError &&
      error.code === 'HARNESS_FIXTURE_BAD_RUN' &&
      /kept no line of stdout/.test(error.message),
  )
  assert.deepEqual(observe(['stdout']), { stdout: '', stderr: 'K1' })
})

const run: NormalizedRun = makeRun(
  [
    {
      ...makeFile('a.test.ts', [
        {
          ...makeTest('a.test.ts', ['s', 't'], {
            status: 'failed',
            passingAssertions: 1,
            errors: [
              {
                name: 'Error',
                message: 'boom',
                matcher: 'toBe',
                userFrame: '<root>/a.test.ts:1:2',
                raw: '/Users/me/x\n at y',
              },
            ],
          }),
          durationMs: 12,
          location: { line: 3, column: 4 },
        },
      ]),
      durationMs: 40,
    },
  ],
  {
    snapshots: {
      counters: {
        added: 0,
        matched: 1,
        unmatched: 0,
        updated: 0,
        unchecked: 0,
        total: 1,
        filesAdded: 0,
        filesRemoved: 0,
        filesUnmatched: 0,
        filesUpdated: 0,
      },
      files: [{ file: '__snapshots__/a.snap', sha256: 'ab' }],
    },
    success: false,
  },
)

test('a golden drops startedAt, env, every duration and every raw', () => {
  const golden = toGolden(run)
  const text = serializeGolden(golden)
  for (const dropped of ['startedAt', 'env', 'durationMs', 'raw', '/Users/me']) {
    assert.equal(text.includes(dropped), false, dropped)
  }
  assert.equal(golden.runner, 'jest')
  assert.equal(golden.runnerVersion, '30.5.2')
  assert.equal(golden.suite, 'unit/suite')
})

test('keys come out in a fixed order, whatever order the input had', () => {
  const shuffled: NormalizedRun = {
    success: run.success,
    runErrors: run.runErrors,
    files: run.files,
    ...(run.snapshots === undefined ? {} : { snapshots: run.snapshots }),
    suite: run.suite,
    runnerVersion: run.runnerVersion,
    runner: run.runner,
    env: run.env,
    startedAt: run.startedAt,
    schemaVersion: run.schemaVersion,
  }
  assert.equal(serializeGolden(toGolden(shuffled)), serializeGolden(toGolden(run)))
  assert.deepEqual(Object.keys(toGolden(run)), [
    'schemaVersion',
    'runner',
    'runnerVersion',
    'suite',
    'files',
    'snapshots',
    'runErrors',
    'success',
  ])
  const test0 = toGolden(run).files[0]?.tests[0]
  assert.deepEqual(Object.keys(test0 ?? {}), [
    'id',
    'status',
    'errors',
    'passingAssertions',
    'location',
  ])
  assert.deepEqual(Object.keys(test0?.errors[0] ?? {}), ['name', 'message', 'matcher', 'userFrame'])
})

test('the file is 2-space JSON with one trailing newline, and round-trips', () => {
  const text = serializeGolden(toGolden(run))
  assert.ok(text.endsWith('}\n'))
  assert.equal(text.endsWith('\n\n'), false)
  assert.ok(text.startsWith('{\n  "schemaVersion": 1,\n'))
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(toGolden(run))))
})

test('optional fields that are absent stay absent', () => {
  const plain = toGolden(makeRun([makeFile('a.test.ts', [makeTest('a.test.ts', ['t'])])]))
  const [t] = plain.files[0]?.tests ?? []
  assert.deepEqual(t, {
    id: { file: 'a.test.ts', path: ['t'], dupIndex: 0 },
    status: 'passed',
    errors: [],
  })
  assert.equal('snapshots' in plain, false)
})

test('goldenPath is <fixture>/__goldens__/<profile>.json', () => {
  assert.equal(goldenPath('/f/area/x', 'jest'), '/f/area/x/__goldens__/jest.json')
  assert.equal(goldenPath('/f/area/x', 'vitest'), '/f/area/x/__goldens__/vitest.json')
  assert.equal(goldenPath('/f/area/x', 'vitest-list'), '/f/area/x/__goldens__/vitest-list.json')
})

const vitestRun: NormalizedRun = { ...run, runner: 'vitest', runnerVersion: '5.0.5' }

test('a golden has a profile only when it is not the runner itself', () => {
  assert.equal('profile' in toGolden(vitestRun), false)
  assert.equal('profile' in toGolden(vitestRun, { profile: 'vitest' }), false)
  assert.equal('profile' in toGolden(run, { profile: 'jest' }), false)
  const list = toGolden(vitestRun, { profile: 'vitest-list' })
  assert.equal(list.runner, 'vitest')
  assert.equal(list.profile, 'vitest-list')
})

test('a golden has a trace only when something was traced, and the steps keep their order', () => {
  assert.equal('trace' in toGolden(run), false)
  assert.equal('trace' in toGolden(run, { trace: [] }), false)
  const steps = ['test L3a', 'beforeEach L2 #1', '', 'afterAll L1 #2']
  assert.deepEqual(toGolden(run, { trace: steps }).trace, steps)
})

test('profile follows the runner and trace comes last, whatever the order of the extras', () => {
  const golden = toGolden(vitestRun, { trace: ['a'], profile: 'vitest-list' })
  assert.deepEqual(Object.keys(golden), [
    'schemaVersion',
    'runner',
    'profile',
    'runnerVersion',
    'suite',
    'files',
    'snapshots',
    'runErrors',
    'success',
    'trace',
  ])
  const text = serializeGolden(golden)
  assert.ok(text.endsWith('  "trace": [\n    "a"\n  ]\n}\n'))
  assert.equal(text, serializeGolden(toGolden(vitestRun, { profile: 'vitest-list', trace: ['a'] })))
})

test('extras cannot add a field the golden does not list', () => {
  const sneaky = { trace: ['a'], extra: 'leak' }
  assert.equal(serializeGolden(toGolden(run, sneaky)).includes('leak'), false)
})

test('a field no golden level lists does not get through, at any level', () => {
  const extra = { extra: 'leak' }
  const leaky: NormalizedRun = {
    ...run,
    ...extra,
    files: run.files.map((file) => ({
      ...file,
      ...extra,
      fileError: { message: 'file error', raw: 'r', ...extra },
      tests: file.tests.map((t) => ({
        ...t,
        ...extra,
        errors: t.errors.map((e) => ({ ...e, ...extra })),
      })),
    })),
    runErrors: [{ message: 'run error', raw: 'r', ...extra }],
  }
  assert.equal(serializeGolden(toGolden(leaky)).includes('leak'), false)
})

test('snapshot counters come out in a fixed order, whatever the producer’s', () => {
  const counters = run.snapshots?.counters
  assert.ok(counters)
  const reversed = Object.fromEntries(Object.entries(counters).reverse()) as typeof counters
  const golden = toGolden({
    ...run,
    snapshots: { counters: { ...reversed, ...{ didUpdate: true } }, files: [] },
  })
  assert.deepEqual(Object.keys(golden.snapshots?.counters ?? {}), Object.keys(counters))
})

test('parts that are already the right shape are passed through as they are', () => {
  const [test0] = run.files[0]?.tests ?? []
  const [golden0] = toGolden(run).files[0]?.tests ?? []
  assert.deepEqual(golden0?.id, test0?.id)
  assert.deepEqual(golden0?.location, test0?.location)
  assert.deepEqual(toGolden(run).snapshots?.files, run.snapshots?.files)
})

test('sortStdout "json" records the JSON array of paths in a stream or a file as a sorted set', () => {
  const list = '["<root>/z.test.ts","<root>/a.test.ts"]'
  const observe = (stdout: string) =>
    observedOf(
      { capture: ['stdout', 'file:out.json'], sortStdout: 'json' },
      { exitCode: 0, stdout, stderr: '' },
      { 'out.json': '["/work/b","/work/a"]' },
      (text) => text.replaceAll('/work', '<root>'),
      'fixture.json',
    )
  assert.deepEqual(observe(list), {
    stdout: '<root>/a.test.ts\n<root>/z.test.ts',
    files: { 'out.json': '<root>/a\n<root>/b' },
  })
  assert.throws(
    () => observe('no list here'),
    (error: unknown) =>
      error instanceof HarnessError &&
      error.code === 'HARNESS_FIXTURE_BAD_RUN' &&
      /not one JSON array of strings/.test(error.message),
  )
})

test('a json: capture is parsed, with times, the root, frame runs and masks normalized', () => {
  const file = JSON.stringify({
    startTime: 1700000000000,
    keep: 7,
    nested: [{ duration: 12.5, name: 'x' }, { duration: null }],
    message:
      'boom in /work/a.ts\n    at fn (/work/a.ts:1:2)\n    at other (/work/b.ts:3:4)\nafter pid 4242',
  })
  const spec = {
    capture: ['json:out.json', 'json:gone.json'],
    missingJson: ['json:gone.json'],
    timeKeys: ['startTime', 'duration'],
    mask: ['pid \\d+'],
  }
  assert.deepEqual(
    observedOf(
      spec,
      { exitCode: 0, stdout: '', stderr: '' },
      { 'out.json': file, 'gone.json': null },
      (text) => text,
      'fixture.json',
      ['/work'],
    ),
    {
      json: {
        'out.json': {
          startTime: '<time>',
          keep: 7,
          nested: [{ duration: '<time>', name: 'x' }, { duration: null }],
          message: 'boom in <root>/a.ts\n<frames>\nafter <masked>',
        },
        'gone.json': null,
      },
    },
  )
  assert.throws(
    () =>
      observedOf(
        { capture: ['json:x.json'] },
        { exitCode: 0, stdout: '', stderr: '' },
        { 'x.json': 'nope' },
        (text) => text,
        'fixture.json',
      ),
    (error: unknown) => error instanceof HarnessError && error.code === 'HARNESS_FIXTURE_BAD_RUN',
  )
})

test('a json: capture the run did not write is refused unless the fixture lists it in missingJson', () => {
  const observe = (spec: { capture: string[]; missingJson?: string[] }) =>
    observedOf(
      spec,
      { exitCode: 0, stdout: '', stderr: '' },
      { 'gone.json': null },
      (text) => text,
      'fixture.json',
    )
  assert.throws(
    () => observe({ capture: ['json:gone.json'] }),
    (error: unknown) =>
      error instanceof HarnessError &&
      error.code === 'HARNESS_FIXTURE_BAD_RUN' &&
      /json:gone\.json/.test(error.message) &&
      /missingJson/.test(error.message),
  )
  assert.deepEqual(observe({ capture: ['json:gone.json'], missingJson: ['json:gone.json'] }), {
    json: { 'gone.json': null },
  })
})

test('a json: capture collapses only stack frames, not message lines that start with "at "', () => {
  const message = [
    'Error: boom',
    '',
    'at the end of the road',
    '',
    '    at fn (/work/a.ts:1:2)',
    '    at /work/b.ts:3:4',
    '    at Array.map (<anonymous>)',
    'at the very end',
  ].join('\n')
  const observed = observedOf(
    { capture: ['json:r.json'] },
    { exitCode: 0, stdout: '', stderr: '' },
    { 'r.json': JSON.stringify({ message }) },
    (text) => text,
    'fixture.json',
    ['/work'],
  ) as { json: Record<string, { message: string }> }
  assert.equal(
    observed.json['r.json']?.message,
    'Error: boom\n\nat the end of the road\n\n<frames>\nat the very end',
  )
})

test('a json: capture refuses a testResults entry with no string name', () => {
  assert.throws(
    () =>
      observedOf(
        { capture: ['json:r.json'] },
        { exitCode: 0, stdout: '', stderr: '' },
        { 'r.json': JSON.stringify({ testResults: [{ name: '/a' }, { status: 'passed' }] }) },
        (text) => text,
        'fixture.json',
      ),
    (error: unknown) =>
      error instanceof HarnessError &&
      error.code === 'HARNESS_FIXTURE_BAD_RUN' &&
      /name/.test(error.message),
  )
})

test('mask applies to streams and files after normalization', () => {
  const observed = observedOf(
    { capture: ['stderr', 'file:a.txt'], mask: ['\\d{4}-\\d\\d'] },
    { exitCode: 0, stdout: '', stderr: 'at 2026-11 ok' },
    { 'a.txt': 'x 2026-11' },
    (text) => text,
    'fixture.json',
  )
  assert.deepEqual(observed, { stderr: 'at <masked> ok', files: { 'a.txt': 'x <masked>' } })
})

test('a json: capture lists testResults by file name, whatever order the runner finished them in', () => {
  const run = (names: string[]): unknown =>
    observedOf(
      { capture: ['json:r.json'] },
      { exitCode: 0, stdout: '', stderr: '' },
      {
        'r.json': JSON.stringify({
          testResults: names.map((name) => ({ name, status: 'passed' })),
        }),
      },
      (text) => text,
      'fixture.json',
    )
  assert.deepEqual(
    run(['/b.test.ts', '/a.test.ts', '/c.test.ts']),
    run(['/c.test.ts', '/a.test.ts', '/b.test.ts']),
  )
  assert.deepEqual(
    (run(['/b', '/a']) as { json: Record<string, { testResults: { name: string }[] }> }).json[
      'r.json'
    ]?.testResults.map((entry) => entry.name),
    ['/a', '/b'],
  )
})
