// Run by mock-fn.test.ts in a child process started with --disallow-code-generation-from-strings,
// with a MockPolicy as JSON in argv[2]. Creating a mock must not generate code from a string:
// jest-mock doesn't for an unnamed mock, and a host (a locked-down runtime) can forbid it.
import assert from 'node:assert/strict'
import type { MockPolicy } from '@provino/types'
import { createMockFn } from '../mock-fn.ts'
import { createMockRegistry } from '../registry.ts'
import type { UnknownFunction } from '../types.ts'

// The flag is on, or this probe proves nothing.
assert.throws(() => new Function('return 1'), EvalError)

const policy = JSON.parse(process.argv[2] ?? 'null') as MockPolicy
const registry = createMockRegistry()
const bare = createMockFn(policy, registry)
assert.equal(bare.length, 0)
const withImpl = createMockFn<UnknownFunction>(policy, registry, {
  impl: (first: unknown, second: unknown) => [first, second],
})
assert.equal(withImpl.length, 2)
assert.deepEqual(withImpl(1, 2, 3), [1, 2])
assert.deepEqual(withImpl.mock.calls, [[1, 2, 3]])
bare()
assert.equal(bare.mock.calls.length, 1)
console.log('created')
