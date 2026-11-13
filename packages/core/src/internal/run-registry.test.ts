import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestRunHandle } from '@provino/types'
import { createRunRegistry } from './run-registry.ts'

const handle = (name: string): TestRunHandle => ({ name }) as unknown as TestRunHandle

test('a context reads back the run it was given; anything else reads undefined', () => {
  const runs = createRunRegistry()
  const ctx = {}
  const run = handle('a')
  runs.set(ctx, run)
  assert.equal(runs.get(ctx), run)
  assert.equal(runs.get({}), undefined)
})

test('a callable context (Vitest’s) works the same', () => {
  const runs = createRunRegistry()
  const ctx = (): void => {}
  const run = handle('a')
  runs.set(ctx, run)
  assert.equal(runs.get(ctx), run)
})

test('a primitive reads undefined instead of throwing, as WeakMap.get answered', () => {
  const runs = createRunRegistry()
  for (const value of [undefined, null, 1, 'ctx', Symbol('x'), true]) {
    assert.equal(runs.get(value as unknown as object), undefined)
  }
})

test('one registry never reads another’s runs, like one WeakMap per runtime', () => {
  const first = createRunRegistry()
  const second = createRunRegistry()
  const ctx = {}
  first.set(ctx, handle('first'))
  assert.equal(second.get(ctx), undefined)
})

test('the run is invisible to reflection: keys, symbols, a spread and JSON', () => {
  const runs = createRunRegistry()
  const ctx = { task: 't' }
  runs.set(ctx, handle('a'))
  assert.deepEqual(Reflect.ownKeys(ctx), ['task'])
  assert.deepEqual({ ...ctx }, { task: 't' })
  assert.equal(JSON.stringify(ctx), '{"task":"t"}')
})
