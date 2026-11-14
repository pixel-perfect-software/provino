import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { reachBackwards, reverseOf } from './inverse.ts'

const graph = (edges: Record<string, string[]>) =>
  reverseOf(new Map(Object.entries(edges).map(([file, deps]) => [file, new Set(deps)])))
const isTest = (file: string): boolean => file.endsWith('.test')

describe('reachBackwards', () => {
  const g = graph({ 'a.test': ['mid'], 'b.test': ['other'], mid: ['leaf'], 'c.test': ['leaf'] })

  it('finds every test above a seed, passing through sources', () => {
    assert.deepEqual([...reachBackwards(['leaf'], g, isTest)].sort(), ['a.test', 'c.test'])
  })

  it('a seed that is a test is selected, and one that reaches nothing selects nothing', () => {
    assert.deepEqual([...reachBackwards(['b.test'], g, isTest)], ['b.test'])
    assert.deepEqual([...reachBackwards(['nobody'], g, isTest)], [])
  })

  it('ends on a cycle', () => {
    const cyclic = graph({ x: ['y'], y: ['x'], 'a.test': ['x'] })
    assert.deepEqual([...reachBackwards(['y'], cyclic, isTest)], ['a.test'])
  })

  it('walks through a test that imports a test', () => {
    const nested = graph({ 'a.test': ['b.test'], 'b.test': ['leaf'] })
    assert.deepEqual([...reachBackwards(['leaf'], nested, isTest)].sort(), ['a.test', 'b.test'])
  })
})
