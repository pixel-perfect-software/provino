import { loaded } from 'load-flag'

it('sees its own evaluation of the package in the second file too', () => {
  expect(loaded).toBe(true)
  expect(globalThis.__loadedFlag).toBe(1)
  expect(globalThis.atob.name).toBe('patchedAtob')
})
