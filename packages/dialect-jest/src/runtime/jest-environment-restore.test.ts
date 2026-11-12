// The adapter puts the worker's global back however a file ended: a class whose `teardown` throws, a
// setup that fails, and built-ins (`fetch`, `setTimeout`) a test replaced. Jest gives each file a
// fresh vm context, so none of these can reach the next file there; here the worker's global is
// shared, so the adapter does the restoring. In process, with a stand-in environment class.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EnvironmentSetupContext } from '@provino/types'
import { fromJestEnvironment, type JestEnvironmentClass } from './jest-environment.ts'

const global = globalThis as Record<string, unknown>

function context(): EnvironmentSetupContext<{ readonly [key: string]: never }> {
  return {
    options: {},
    realm: 'worker',
    scope: 'file',
    testPath: `${process.cwd()}/restore.test.js`,
    pragmas: {},
    console,
    signal: new AbortController().signal,
  } as unknown as EnvironmentSetupContext<{ readonly [key: string]: never }>
}

function environmentClass(
  behaviour: { setup?: () => Promise<void>; teardown?: () => Promise<void> } = {},
): { Class: JestEnvironmentClass; torn: () => number } {
  let torn = 0
  class Fake {
    readonly global = { document: { title: 'fake' }, __fromFakeEnvironment: 1 }
    async setup(): Promise<void> {
      await behaviour.setup?.()
    }
    async teardown(): Promise<void> {
      torn++
      await behaviour.teardown?.()
    }
  }
  return { Class: Fake as unknown as JestEnvironmentClass, torn: () => torn }
}

const cleanOf = (): boolean =>
  !('document' in global) && !('__fromFakeEnvironment' in global) && !('__added' in global)

test('a teardown that throws still puts the global back, and the error is rethrown', async () => {
  const { Class } = environmentClass({
    teardown: async () => {
      throw new Error('teardown boom')
    },
  })
  const instance = await fromJestEnvironment(Class).setup(context(), undefined)
  assert.ok('document' in global)
  global.__added = 1
  await assert.rejects(async () => instance.teardown(), /teardown boom/)
  assert.ok(cleanOf(), 'no accessor of the window stays on the worker global')
})

test('a setup that rejects tears the environment down and leaves nothing behind', async () => {
  const { Class, torn } = environmentClass({
    setup: async () => {
      throw new Error('setup boom')
    },
  })
  await assert.rejects(
    async () => fromJestEnvironment(Class).setup(context(), undefined),
    /setup boom/,
  )
  assert.equal(torn(), 1, 'teardown ran, as Jest runs it')
  assert.ok(cleanOf())
})

test('a built-in a test replaced on the global is back after teardown', async () => {
  const { Class } = environmentClass()
  const keys = ['fetch', 'setTimeout', 'structuredClone'] as const
  const originals = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key))
  const instance = await fromJestEnvironment(Class).setup(context(), undefined)
  for (const key of keys) global[key] = () => 'mocked'
  try {
    await instance.teardown()
    keys.forEach((key, index) => {
      const now = Object.getOwnPropertyDescriptor(globalThis, key)
      assert.equal(now?.value, originals[index]?.value, `${key} is the original`)
    })
  } finally {
    keys.forEach((key, index) => {
      const original = originals[index]
      if (original !== undefined) Object.defineProperty(globalThis, key, original)
    })
  }
})

test('an assignment to a closure-backed accessor (`performance`) does not reach the next file', async () => {
  const { Class } = environmentClass()
  const original = global.performance
  const fake = { now: () => 0 }
  const instance = await fromJestEnvironment(Class).setup(context(), undefined)
  global.performance = fake
  try {
    assert.equal(global.performance, fake, 'the file sees its own value')
    await instance.teardown()
    assert.equal(global.performance, original, 'the next file sees the original')
  } finally {
    global.performance = original
  }
})
