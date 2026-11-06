import assert from 'node:assert/strict'
import { test } from 'node:test'
import { caseId, compareObservations, sameOrder } from './compare.ts'

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
