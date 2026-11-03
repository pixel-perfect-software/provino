import assert from 'node:assert/strict'
import { test } from 'node:test'
import { manualCurrentTest, testTask } from './internal/test-support.ts'
import { createStateSource } from './state.ts'

const setup = () => {
  const current = manualCurrentTest()
  const source = createStateSource(current, { nameSeparator: ' ', expand: true })
  return { current, source }
}

test('outside a test the file state is current, with expand and fresh counters', () => {
  const { source } = setup()
  assert.equal(source.current(), source.file())
  assert.deepEqual(source.current(), {
    assertionCalls: 0,
    expectedAssertionsNumber: null,
    isExpectingAssertions: false,
    numPassingAsserts: 0,
    suppressedErrors: [],
    expand: true,
  })
})

test('each test gets its own state, named by the separator', () => {
  const { current, source } = setup()
  const a = testTask('a', ['suite', 'a'])
  const b = testTask('b', ['suite', 'b'])
  current.enter(a)
  source.current().assertionCalls = 3
  current.enter(b)
  assert.equal(source.current().assertionCalls, 0)
  assert.equal(source.current().currentTestName, 'suite b')
  current.enter(a)
  assert.equal(source.current().assertionCalls, 3)
  assert.equal(source.current().currentTestName, 'suite a')
  assert.equal(source.stateOf('a')?.assertionCalls, 3)
  assert.equal(source.stateOf('missing'), undefined)
})

test('a new attempt of the same test starts over', () => {
  const { current, source } = setup()
  const a = testTask('a')
  current.enter(a, 0)
  source.current().assertionCalls = 2
  current.enter(a, 1)
  assert.equal(source.current().assertionCalls, 0)
})

test('a test starts from the file state: keys carry, counters and expectation errors reset', () => {
  const { current, source } = setup()
  Object.assign(source.file(), {
    custom: 'from beforeAll',
    assertionCalls: 7,
    expectedAssertionsNumber: 4,
    expectedAssertionsNumberError: new Error('file'),
    isExpectingAssertions: true,
    isExpectingAssertionsError: new Error('file'),
  })
  current.enter(testTask('a'))
  const state = source.current()
  assert.equal(state.custom, 'from beforeAll')
  assert.equal(state.expand, true)
  assert.equal(state.assertionCalls, 0)
  assert.equal(state.expectedAssertionsNumber, null)
  assert.equal(state.isExpectingAssertions, false)
  assert.equal('expectedAssertionsNumberError' in state, false)
  assert.equal('isExpectingAssertionsError' in state, false)
})

test('a key a test sets stays in that test', () => {
  const { current, source } = setup()
  current.enter(testTask('a'))
  source.current().custom = 1
  current.enter(testTask('b'))
  assert.equal(source.current().custom, undefined)
  assert.equal(source.file().custom, undefined)
})

test('startFile gives a fresh file state with testPath and drops the tests', () => {
  const { current, source } = setup()
  current.enter(testTask('a'))
  source.current().assertionCalls = 1
  source.startFile('/x/a.test.ts')
  assert.equal(source.stateOf('a'), undefined)
  assert.equal(source.file().testPath, '/x/a.test.ts')
  current.enter(testTask('a'))
  assert.equal(source.current().assertionCalls, 0)
  assert.equal(source.current().testPath, '/x/a.test.ts')
})
