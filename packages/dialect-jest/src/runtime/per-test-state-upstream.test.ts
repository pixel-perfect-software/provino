// Spike E's own setup (T7.2): **unmodified** `expect@30.5.2` behind our slot. Its own process,
// because Jest's `expect` writes its built-in matchers into the slot's registry as it loads. With
// our slot installed first, Jest's module finds the slot already defined, keeps it, and its
// `getState()` reads the current test's state, so 50 interleaved tests count correctly with
// Jest's own engine too. Third-party matcher code that reads the slot gets the same.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { currentTest } from '@provino/core'
import {
  createMatcherRegistry,
  createStateSource,
  installMatchersSlot,
  MATCHERS_SLOT,
} from '@provino/expect'
import { neutralPolicy } from '@provino/policy'
import {
  COUNT,
  countedCorrectly,
  countingBody,
  runInterleaved,
  SEED,
} from './internal/test-support.ts'

test('50/50 with unmodified expect@30.5.2 loaded after our slot', async () => {
  const source = createStateSource(currentTest, {
    nameSeparator: neutralPolicy.core.nameSeparator,
    expand: false,
  })
  const registry = createMatcherRegistry()
  const slot = installMatchersSlot(source, registry)
  try {
    const ours = Object.getOwnPropertyDescriptor(globalThis, MATCHERS_SLOT)
    const { expect } = await import('expect')
    assert.equal(Object.getOwnPropertyDescriptor(globalThis, MATCHERS_SLOT)?.value, ours?.value)
    assert.equal(typeof registry.matchers.toBe, 'function', 'Jest registered into our registry')

    const { counted, peak } = await runInterleaved(COUNT, SEED, countingBody(expect))
    assert.equal(peak, COUNT)
    const correct = countedCorrectly(counted)
    assert.equal(correct.length, COUNT, `${correct.length}/${COUNT} counted correctly`)
  } finally {
    slot.uninstall()
  }
})
