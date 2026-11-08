import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { installGlobals, splitGlobals } from './globals.ts'

describe('splitGlobals', () => {
  const values = { describe: 1, expect: 2, jest: 3 }

  it('puts every global before the setup files under all', () => {
    assert.deepEqual(splitGlobals(values, 'all'), { before: values, after: {} })
  })

  it('puts only the listed names before, and ignores a listed name nothing builds', () => {
    assert.deepEqual(splitGlobals(values, ['jest', 'vi']), {
      before: { jest: 3 },
      after: { describe: 1, expect: 2 },
    })
    assert.deepEqual(splitGlobals(values, []), { before: {}, after: values })
  })
})

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
