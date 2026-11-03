// Each run of a test, every retry attempt and every repeat, counts into its own state, through
// core's real runtime: the frame names both the attempt and the repeat (B08 review).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runRegistered, setUpJestExpect } from './internal/test-support.ts'

test('each repeat starts with fresh counters', async (t) => {
  const { expect } = setUpJestExpect(t)
  const seen: number[] = []
  await runRegistered((api) => {
    api.test('repeated', { repeats: 2 }, () => {
      expect(1).toBe(1)
      seen.push(expect.getState().assertionCalls)
    })
  })
  assert.deepEqual(seen, [1, 1, 1])
})

test('stateOf gives each run its own counts, and a retry that asserts nothing has none', async (t) => {
  const { expect, source } = setUpJestExpect(t)
  let attempt = 0
  const events = await runRegistered((api) => {
    api.test('retried', { retry: 1 }, () => {
      if (attempt++ === 0) {
        expect(1).toBe(1)
        throw new Error('first attempt fails')
      }
    })
  })
  const ends = events.flatMap((event) => (event.type === 'test-attempt-end' ? [event] : []))
  assert.deepEqual(
    ends.map(({ attempt, repeat }) => [attempt, repeat]),
    [
      [0, 0],
      [1, 0],
    ],
  )
  const [first, second] = ends
  assert.ok(first !== undefined && second !== undefined)
  assert.equal(source.stateOf(first.id, first)?.numPassingAsserts, 1)
  assert.equal(source.stateOf(second.id, second), undefined)
})
