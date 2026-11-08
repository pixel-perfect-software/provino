import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SerializedError } from '@provino/types'
import type { GoldenFile } from '../golden.ts'
import type { CoreRun } from '../runtime-corpus/run-core.ts'
import { assertFileOutcome, caseId, causeText, compareObservations, sameOrder } from './compare.ts'

const error: SerializedError = { name: 'Error', message: 'x' }

function coreRun(overrides: Partial<CoreRun> = {}): CoreRun {
  return {
    trace: [],
    tests: [{ path: ['t'], dupIndex: 0, status: 'passed', location: null, errors: [] }],
    fileStatus: 'passed',
    fileErrors: [],
    collectionErrors: [],
    unhandled: [],
    ...overrides,
  }
}

function goldenFile(overrides: Partial<GoldenFile> = {}): GoldenFile {
  return {
    file: 'a.test.ts',
    status: 'passed',
    tests: [
      {
        id: { file: 'a.test.ts', path: ['t'], dupIndex: 0 },
        status: 'passed',
        errors: [],
        passingAssertions: 0,
      },
    ],
    ...overrides,
  }
}

test('assertFileOutcome accepts a run that ended as the golden did', () => {
  assertFileOutcome(coreRun(), goldenFile())
})

test('assertFileOutcome refuses another file status', () => {
  assert.throws(
    () => assertFileOutcome(coreRun({ fileStatus: 'failed' }), goldenFile()),
    /file status/,
  )
})

test('assertFileOutcome refuses a file error the golden lacks and one it has that the run lacks', () => {
  assert.throws(
    () => assertFileOutcome(coreRun({ fileErrors: [error] }), goldenFile()),
    /whether the file carries an error/,
  )
  assert.throws(
    () => assertFileOutcome(coreRun(), goldenFile({ fileError: { message: 'boom' } })),
    /whether the file carries an error/,
  )
})

test('assertFileOutcome refuses errors on the wrong tests', () => {
  const failing = coreRun({
    tests: [{ path: ['t'], dupIndex: 0, status: 'passed', location: null, errors: [error] }],
  })
  assert.throws(() => assertFileOutcome(failing, goldenFile()), /which carry errors/)
})

test('assertFileOutcome leaves the file error alone when a golden test failed', () => {
  const failed = goldenFile({
    tests: [
      {
        id: { file: 'a.test.ts', path: ['t'], dupIndex: 0 },
        status: 'failed',
        errors: [{ message: 'no' }],
        passingAssertions: 0,
      },
    ],
  })
  assertFileOutcome(
    coreRun({
      tests: [{ path: ['t'], dupIndex: 0, status: 'failed', location: null, errors: [error] }],
      fileErrors: [error],
    }),
    failed,
  )
})

test('causeText reads the paragraph after the Jest header, or else the first paragraph', () => {
  const jest = "● Test suite failed to run\n\n    ReferenceError: Cannot access 'a' before init"
  assert.equal(causeText(jest), "ReferenceError: Cannot access 'a' before init")
  assert.equal(causeText('Cannot find module /x.ts\n\nmore'), 'Cannot find module /x.ts')
  assert.equal(causeText(''), '')
  assert.equal(causeText('● Test suite failed to run\n\n'), '')
})

test('causeText keeps a multi-line cause and drops what follows it and the Allowed objects line', () => {
  const message =
    '● Test suite failed to run\n\n    f.ts: The factory is out of scope.\n    Invalid variable access: x\n    Allowed objects: a, b.\n    Note: use mock.\n\n      1 | code frame'
  assert.equal(
    causeText(message),
    'f.ts: The factory is out of scope.\nInvalid variable access: x\nNote: use mock.',
  )
})

const a = '{"id":"a","value":1}'
const b = '{"id":"b","value":2}'

test('caseId reads the id of an observation and names a non-observation by its text', () => {
  assert.equal(caseId(a), 'a')
  assert.equal(caseId('plain'), 'plain')
  assert.equal(caseId('{"value":1}'), '{"value":1}')
  assert.equal(caseId('{"id":3}'), '{"id":3}')
})

test('equal lines match, in the golden order', () => {
  assert.deepEqual(
    compareObservations([a, b], [b, a]).map(({ id, matches }) => [id, matches]),
    [
      ['a', true],
      ['b', true],
    ],
  )
})

test('a different value, a missing case and an extra case are each a difference', () => {
  const changed = '{"id":"a","value":9}'
  const extra = '{"id":"c","value":3}'
  assert.deepEqual(compareObservations([a, b], [changed, extra]), [
    { id: 'a', matches: false, want: a, got: changed },
    { id: 'b', matches: false, want: b, got: undefined },
    { id: 'c', matches: false, want: undefined, got: extra },
  ])
})

test('a case observed twice is refused, in the golden and in the run', () => {
  assert.throws(() => compareObservations([a, a], []), /golden observes "a" twice/)
  assert.throws(() => compareObservations([], [a, a]), /run observes "a" twice/)
})

test('sameOrder compares the sequence of ids, not only the set', () => {
  assert.equal(sameOrder([a, b], [a, b]), true)
  assert.equal(sameOrder([a, b], [b, a]), false)
  assert.equal(sameOrder([a, b], [a]), false)
  assert.equal(sameOrder([a], [a, b]), false)
  // The lines are not compared here: `compareObservations` does that.
  assert.equal(sameOrder([a], ['{"id":"a","value":9}']), true)
})
