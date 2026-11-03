import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AsymmetricMatcher } from './asymmetric.ts'
import type { MatcherContext } from './context.ts'
import { manualCurrentTest, testTask } from './internal/test-support.ts'
import { createMatcherRegistry, installMatchersSlot } from './slot.ts'
import { createStateSource } from './state.ts'

class Probe extends AsymmetricMatcher<number> {
  asymmetricMatch(other: unknown): boolean {
    return other === this.sample
  }
  toString(): string {
    return 'Probe'
  }
  context(): MatcherContext {
    return this.getMatcherContext()
  }
}

test('the base implements the protocol', () => {
  const probe = new Probe(1)
  assert.equal(probe.$$typeof, Symbol.for('jest.asymmetricMatcher'))
  assert.equal(probe.asymmetricMatch(1), true)
  assert.deepEqual(Object.keys(probe), ['$$typeof', 'sample', 'inverse'])
})

test('without a slot the context has empty state and no testers', () => {
  const context = new Probe(1, true).context()
  assert.equal(context.isNot, true)
  assert.equal(context.assertionCalls, 0)
  assert.deepEqual(context.customTesters, [])
  assert.deepEqual(context.utils, {})
  assert.equal('promise' in context, false)
})

test('with our slot the context reads the current state, testers and utils', () => {
  const current = manualCurrentTest()
  const source = createStateSource(current, { nameSeparator: ' ', expand: false })
  const registry = createMatcherRegistry()
  registry.utils = { tag: 'utils' }
  const tester = () => undefined
  registry.customEqualityTesters.push(tester)
  const handle = installMatchersSlot(source, registry)
  try {
    current.enter(testTask('a'))
    source.current().assertionCalls = 4
    const context = new Probe(1).context()
    assert.equal(context.assertionCalls, 4)
    assert.equal(context.currentTestName, 'a')
    assert.deepEqual(context.customTesters, [tester])
    assert.deepEqual(context.utils, { tag: 'utils' })
    assert.equal(context.isNot, false)
  } finally {
    handle.uninstall()
  }
})
