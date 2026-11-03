// Spike E (T7.2): 50 interleaved `test.concurrent` tests, each with `expect.assertions(n)`, count
// correctly with the global `expect`, because each test attempt has its own state. Jest's one
// global state miscounts here (spike P4/P5); the control shows the test would catch that.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createExpect,
  createMatcherRegistry,
  MATCHERS_SLOT,
  type StateSource,
} from '@provino/expect'
import type { MatcherState } from '@provino/types'
import { jestExpectPolicy } from '../expect-policy.ts'
import { jestExpectTable } from './expect-table.ts'
import { type CountingBody, runInterleaved, setUpJestExpect } from './internal/test-support.ts'

const COUNT = 50
const SEED = 20261103

test('50/50 interleaved tests count their own assertions', async () => {
  const { expect, slot } = setUpJestExpect()
  try {
    const body: CountingBody = async (n, pause) => {
      expect.assertions(n)
      for (let i = 0; i < n; i++) {
        await pause()
        expect(i).toBe(i)
      }
      await pause()
      // What third-party code reading the slot sees, and what `expect.getState()` says, agree.
      const viaSlot = (Reflect.get(globalThis, MATCHERS_SLOT) as { state: MatcherState }).state
      assert.equal(viaSlot, expect.getState())
      const { assertionCalls, expectedAssertionsNumber } = expect.getState()
      return { assertionCalls, expectedAssertionsNumber }
    }
    const { counted, peak } = await runInterleaved(COUNT, SEED, body)
    assert.equal(peak, COUNT, 'every test was running at once')
    const correct = counted.filter(
      (c) => c.assertionCalls === c.n && c.expectedAssertionsNumber === c.n,
    )
    assert.equal(counted.length, COUNT)
    assert.equal(correct.length, COUNT, `${correct.length}/${COUNT} counted correctly`)
  } finally {
    slot.uninstall()
  }
})

test('control: one shared state, reset as each test starts (as in Jest), miscounts', async () => {
  const shared: MatcherState = {
    assertionCalls: 0,
    expectedAssertionsNumber: null,
    isExpectingAssertions: false,
    numPassingAsserts: 0,
    suppressedErrors: [],
  }
  const source: StateSource = {
    current: () => shared,
    file: () => shared,
    startFile: () => {},
    stateOf: () => shared,
  }
  const expect = createExpect({
    policy: jestExpectPolicy,
    table: jestExpectTable(),
    source,
    registry: createMatcherRegistry(),
  })
  const { counted } = await runInterleaved(COUNT, SEED, async (n, pause) => {
    Object.assign(shared, { assertionCalls: 0, expectedAssertionsNumber: null })
    expect.assertions(n)
    for (let i = 0; i < n; i++) {
      await pause()
      expect(i).toBe(i)
    }
    await pause()
    const { assertionCalls, expectedAssertionsNumber } = expect.getState()
    return { assertionCalls, expectedAssertionsNumber }
  })
  const wrong = counted.filter(
    (c) => c.assertionCalls !== c.n || c.expectedAssertionsNumber !== c.n,
  )
  assert.ok(wrong.length > COUNT / 2, `only ${wrong.length}/${COUNT} miscounted`)
})
