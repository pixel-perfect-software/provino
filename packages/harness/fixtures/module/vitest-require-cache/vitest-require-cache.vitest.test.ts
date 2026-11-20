import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const counter = require.resolve('./counter.cjs')

test('a test file has no require of its own', () => {
  expect(typeof (globalThis as { require?: unknown }).require).toBe('undefined')
})

test('the cache holds a required file', () => {
  require('./counter.cjs')
  expect(counter in require.cache).toBe(true)
})

test('deleting the entry evaluates the file again', () => {
  const first = (require('./counter.cjs') as { loads: number }).loads
  delete require.cache[counter]
  const second = (require('./counter.cjs') as { loads: number }).loads
  expect(second).toBe(first + 1)
})

test('a property set on the cache stays', () => {
  ;(require.cache as Record<string, unknown>).__provino = undefined
  expect('__provino' in require.cache).toBe(true)
  delete (require.cache as Record<string, unknown>).__provino
})
