import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NormalizedRun } from '@provino/types'
import { goldenPath, serializeGolden, toGolden } from './golden.ts'
import { makeFile, makeRun, makeTest } from './test-support.ts'

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

test('goldenPath is <fixture>/__goldens__/<runner>.json', () => {
  assert.equal(goldenPath('/f/area/x', 'jest'), '/f/area/x/__goldens__/jest.json')
  assert.equal(goldenPath('/f/area/x', 'vitest'), '/f/area/x/__goldens__/vitest.json')
})
