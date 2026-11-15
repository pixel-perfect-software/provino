import styles, { foo } from './a.css'

// A default and a named import together go through Babel's `_interopRequireWildcard`: the proxy
// says `__esModule` is false, so its own keys (none) are copied beside `default`.
it('imports the proxy as the default; a named import reads the empty wildcard copy', () => {
  expect((styles as Record<string, unknown>).foo).toBe('foo')
  expect(foo).toBeUndefined()
})
