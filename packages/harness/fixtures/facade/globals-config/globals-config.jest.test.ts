const g = globalThis as Record<string, unknown>

test('the global is installed', () => {
  expect(g.__APP_VERSION__).toBe('1.2.3')
  expect(g.__FLAGS__).toEqual({ a: 1, list: [1, 2] })
})
test('setupFiles saw it', () => {
  expect(g.__seenInSetup).toEqual({ version: '1.2.3', flags: { a: 1, list: [1, 2] } })
})
test('a bare name reaches it', () => {
  expect(typeof (g as { __APP_VERSION__: string }).__APP_VERSION__).toBe('string')
})
test('it is an own, writable data property', () => {
  const d = Object.getOwnPropertyDescriptor(globalThis, '__APP_VERSION__')
  expect(d?.writable).toBe(true)
  expect(d?.enumerable).toBe(true)
})
