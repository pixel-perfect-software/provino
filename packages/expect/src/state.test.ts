import assert from 'node:assert/strict'
import { test } from 'provino'
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
    pendingAsync: new Set(),
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
  assert.equal(source.stateOf('a', { attempt: 0, repeat: 0 })?.assertionCalls, 3)
  assert.equal(source.stateOf('missing', { attempt: 0, repeat: 0 }), undefined)
})

test('a new attempt of the same test starts over', () => {
  const { current, source } = setup()
  const a = testTask('a')
  current.enter(a, 0)
  source.current().assertionCalls = 2
  current.enter(a, 1)
  assert.equal(source.current().assertionCalls, 0)
})

test('each repeat of a test starts over, as Vitest resets state per try', () => {
  const { current, source } = setup()
  const a = testTask('a')
  current.enter(a, 0, 0)
  source.current().assertionCalls = 1
  source.current().custom = 'repeat 0'
  current.enter(a, 0, 1)
  assert.equal(source.current().assertionCalls, 0)
  assert.equal(source.current().custom, undefined)
})

test('an earlier attempt still running never replaces the live attempt`s state', () => {
  const { current, source } = setup()
  const a = testTask('a')
  current.enter(a, 1)
  source.current().assertionCalls = 2
  source.current().expectedAssertionsNumber = 2
  // Attempt 0 timed out, but its body is still running: it reads its own state.
  current.enter(a, 0)
  source.current().assertionCalls++
  current.enter(a, 1)
  assert.equal(source.current().assertionCalls, 2)
  assert.equal(source.current().expectedAssertionsNumber, 2)
})

test('stateOf names the run: one that never read state has none', () => {
  const { current, source } = setup()
  const a = testTask('a')
  current.enter(a, 0)
  source.current().numPassingAsserts = 1
  assert.equal(source.stateOf('a', { attempt: 0, repeat: 0 })?.numPassingAsserts, 1)
  assert.equal(source.stateOf('a', { attempt: 1, repeat: 0 }), undefined)
  assert.equal(source.stateOf('a', { attempt: 0, repeat: 1 }), undefined)
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
  assert.equal(source.stateOf('a', { attempt: 0, repeat: 0 }), undefined)
  assert.equal(source.file().testPath, '/x/a.test.ts')
  current.enter(testTask('a'))
  assert.equal(source.current().assertionCalls, 0)
  assert.equal(source.current().testPath, '/x/a.test.ts')
})

const carrying = () => {
  const current = manualCurrentTest()
  const source = createStateSource(current, {
    nameSeparator: ' ',
    expand: false,
    outsideTestCounts: 'next-test',
  })
  return { current, source }
}

const first = { attempt: 0, repeat: 0 }

test('next-test: the next attempt takes the counters made outside a test, the file state is zeroed', () => {
  const { current, source } = carrying()
  const file = source.file()
  const held = new Error('held')
  file.assertionCalls = 2
  file.numPassingAsserts = 2
  file.expectedAssertionsNumber = 3
  file.expectedAssertionsNumberError = new Error('number')
  file.isExpectingAssertions = true
  file.isExpectingAssertionsError = new Error('expecting')
  file.suppressedErrors.push(held)
  current.enter(testTask('a'))
  const state = source.current()
  assert.equal(state.assertionCalls, 2)
  assert.equal(state.numPassingAsserts, 2)
  assert.equal(state.expectedAssertionsNumber, 3)
  assert.equal(state.expectedAssertionsNumberError?.message, 'number')
  assert.equal(state.isExpectingAssertions, true)
  assert.equal(state.isExpectingAssertionsError?.message, 'expecting')
  assert.deepEqual(state.suppressedErrors, [held])
  assert.equal(file.assertionCalls, 0)
  assert.equal(file.numPassingAsserts, 0)
  assert.equal(file.expectedAssertionsNumber, null)
  assert.equal(file.expectedAssertionsNumberError, undefined)
  assert.equal(file.isExpectingAssertions, false)
  assert.equal(file.isExpectingAssertionsError, undefined)
  assert.deepEqual(file.suppressedErrors, [])
})

test('next-test: counters carry once, two attempts in a row, and are never taken back', () => {
  const { current, source } = carrying()
  source.file().numPassingAsserts = 1
  current.enter(testTask('a'))
  source.current().numPassingAsserts += 1
  current.enter(testTask('b'))
  assert.equal(source.current().numPassingAsserts, 0)
  current.enter(null)
  source.current().numPassingAsserts = 4
  current.enter(testTask('c'))
  assert.equal(source.current().numPassingAsserts, 4)
  assert.equal(source.stateOf('a', first)?.numPassingAsserts, 2)
  assert.equal(source.file().numPassingAsserts, 0)
})

test('next-test: a retry attempt is a state of its own and takes only what came after', () => {
  const { current, source } = carrying()
  source.file().assertionCalls = 1
  const a = testTask('a')
  current.enter(a, 0)
  assert.equal(source.current().assertionCalls, 1)
  current.enter(a, 1)
  assert.equal(source.current().assertionCalls, 0)
  current.enter(null)
  source.file().assertionCalls = 3
  current.enter(a, 2)
  assert.equal(source.current().assertionCalls, 3)
})

test('next-test: a concurrent pair, the first attempt made takes the counters', () => {
  const { current, source } = carrying()
  source.file().assertionCalls = 1
  const a = testTask('a')
  const b = testTask('b')
  current.enter(a)
  assert.equal(source.current().assertionCalls, 1)
  current.enter(b)
  assert.equal(source.current().assertionCalls, 0)
  current.enter(a)
  assert.equal(source.current().assertionCalls, 1)
})

test('next-test: stateOf is a pure lookup, so a read moves no counts', () => {
  const { source } = carrying()
  source.file().assertionCalls = 3
  assert.equal(source.stateOf('a', first), undefined)
  assert.equal(source.file().assertionCalls, 3)
  assert.equal(source.stateOf('a', first), undefined)
})

test('next-test: settle gives an attempt that counted nothing the counters at its end', () => {
  const { source } = carrying()
  const file = source.file()
  file.isExpectingAssertions = true
  const state = source.settle('a', first)
  assert.equal(state?.isExpectingAssertions, true)
  assert.equal(state?.currentTestId, 'a')
  assert.equal(file.isExpectingAssertions, false)
  assert.equal(source.settle('a', first), state)
  assert.equal(source.stateOf('a', first), state)
  // Nothing to take: no state is made.
  assert.equal(source.settle('b', first), undefined)
})

test('next-test: counts left after an attempt settled empty reach the next attempt, not a later read of it', () => {
  const { current, source } = carrying()
  assert.equal(source.settle('a', first), undefined)
  source.file().numPassingAsserts = 1
  assert.equal(source.stateOf('a', first), undefined)
  current.enter(testTask('b'))
  assert.equal(source.current().numPassingAsserts, 1)
})

test('next-test: counts that land in the file state after an attempt that had a state of its own go to the next attempt', () => {
  const { current, source } = carrying()
  const a = testTask('a')
  current.enter(a, 0)
  source.current().numPassingAsserts = 1
  assert.equal(source.settle('a', first)?.numPassingAsserts, 1)
  current.enter(null)
  // An afterAll's assertion: the file state is current outside a test.
  source.current().numPassingAsserts = 2
  assert.equal(source.stateOf('a', first)?.numPassingAsserts, 1)
  current.enter(a, 1)
  assert.equal(source.current().numPassingAsserts, 2)
  assert.equal(source.file().numPassingAsserts, 0)
})

test('drop: the counters made outside a test reach no test', () => {
  const { current, source } = setup()
  const file = source.file()
  file.assertionCalls = 2
  file.isExpectingAssertions = true
  current.enter(testTask('a'))
  assert.equal(source.current().assertionCalls, 0)
  assert.equal(source.current().isExpectingAssertions, false)
  assert.equal(file.assertionCalls, 2)
  assert.equal(source.settle('b', first), undefined)
})

test('the last-frame cache follows frames, and startFile clears it even for the same frame', () => {
  const { current, source } = setup()
  const a = testTask('a')
  const b = testTask('b')
  current.enter(a)
  const stateA = source.current()
  assert.equal(source.current(), stateA)
  current.enter(b)
  const stateB = source.current()
  assert.notEqual(stateB, stateA)
  current.enter(a)
  assert.equal(source.current(), stateA)
  // The same frame object across a file boundary must not hand back the old file's state.
  source.startFile('/next.test.ts')
  const next = source.current()
  assert.notEqual(next, stateA)
  assert.equal(next.testPath, '/next.test.ts')
})
