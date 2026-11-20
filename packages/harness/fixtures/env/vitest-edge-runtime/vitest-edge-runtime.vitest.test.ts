// What an edge-runtime file sees under Vitest 5.0.5, one observation a test.
declare const EdgeRuntime: unknown

test('EdgeRuntime is a string', () => {
  expect(typeof EdgeRuntime).toBe('string')
})

test('there is no document', () => {
  expect(typeof document).toBe('undefined')
})

test('window is the global', () => {
  expect(typeof window === 'object' && window === globalThis).toBe(true)
})

test('Buffer and fetch are there', () => {
  expect([typeof Buffer, typeof fetch, typeof Response]).toEqual([
    'function',
    'function',
    'function',
  ])
})
