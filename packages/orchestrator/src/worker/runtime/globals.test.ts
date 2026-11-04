import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { installGlobals } from './globals.ts'

describe('installGlobals', () => {
  it('defines configurable, writable, enumerable data properties', () => {
    const target: Record<string, unknown> = {}
    const test = () => {}
    installGlobals(target, { test, answer: 42 })
    assert.deepEqual(Object.getOwnPropertyDescriptor(target, 'test'), {
      value: test,
      configurable: true,
      writable: true,
      enumerable: true,
    })
    assert.equal(target.answer, 42)
  })

  it('replaces what is there without calling a setter, and can run again', () => {
    const calls: unknown[] = []
    const target = {}
    Object.defineProperty(target, 'name', {
      configurable: true,
      get: () => 'old',
      set: (value) => void calls.push(value),
    })
    installGlobals(target, { name: 'new' })
    installGlobals(target, { name: 'new' })
    assert.deepEqual(calls, [])
    assert.equal(Reflect.get(target, 'name'), 'new')
  })

  it('can be undone by deleting the names, which is what an environment’s restore does', () => {
    const target: Record<string, unknown> = { kept: 1 }
    installGlobals(target, { added: 2 })
    assert.equal(Reflect.deleteProperty(target, 'added'), true)
    assert.deepEqual(Object.keys(target), ['kept'])
  })
})
