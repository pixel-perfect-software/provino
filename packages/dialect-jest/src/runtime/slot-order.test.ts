// T7.2: the slot is installed before any matcher module evaluates. Jest's own matcher modules
// read the slot only when a matcher runs, never while they load, so the worker can load the
// table after installing the slot; code that reads the slot as it loads (jest-extended and
// friends, a user setup file) then sees ours. Nothing here imports a matcher module statically:
// the trap must be in place before they load.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { currentTest } from '@provino/core'
import {
  createExpect,
  createMatcherRegistry,
  createStateSource,
  installMatchersSlot,
  MATCHERS_SLOT,
  type MatchersSlot,
} from '@provino/expect'
import { neutralPolicy } from '@provino/policy'
import { jestExpectPolicy } from '../expect-policy.ts'

test('loading the table and its vendored matchers never reads the slot', async () => {
  let reads = 0
  Object.defineProperty(globalThis, MATCHERS_SLOT, {
    configurable: true,
    get: () => {
      reads++
      return undefined
    },
  })
  try {
    const { jestExpectTable } = await import('@provino/dialect-jest/runtime')
    jestExpectTable()
  } finally {
    Reflect.deleteProperty(globalThis, MATCHERS_SLOT)
  }
  assert.equal(reads, 0)
})

test('a module that reads the slot as it loads, after the install, sees ours', async () => {
  const source = createStateSource(currentTest, {
    nameSeparator: neutralPolicy.core.nameSeparator,
    expand: false,
  })
  const registry = createMatcherRegistry()
  const slot = installMatchersSlot(source, registry)
  try {
    const { jestExpectTable } = await import('@provino/dialect-jest/runtime')
    const expect = createExpect({
      policy: jestExpectPolicy,
      table: jestExpectTable(),
      source,
      registry,
    })
    // Shaped like a matcher library's entry: it reads the slot while it evaluates.
    const entry = `data:text/javascript,export const seen = globalThis[Symbol.for('$$jest-matchers-object')]`
    const plugin = (await import(entry)) as { seen: MatchersSlot }
    assert.equal(plugin.seen, Reflect.get(globalThis, MATCHERS_SLOT))
    assert.equal(plugin.seen.matchers, registry.matchers)
    assert.equal(typeof plugin.seen.matchers.toEqual, 'function')
    assert.equal(plugin.seen.state, source.file())
    expect(1).toBe(1)
    assert.equal(plugin.seen.state.numPassingAsserts, 1)
  } finally {
    slot.uninstall()
  }
})
