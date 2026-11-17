import { loaded } from 'load-flag'

it('sees the flag and the wrapper the package wrote as it loaded', () => {
  expect(loaded).toBe(true)
  expect(globalThis.__loadedFlag).toBe(1)
  expect(globalThis.atob.name).toBe('patchedAtob')
  expect(atob('aGk=')).toBe('hi')
})
