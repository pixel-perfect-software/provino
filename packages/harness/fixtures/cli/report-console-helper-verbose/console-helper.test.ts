// helper.cjs is written beside this file by the fixture's `files`, so it is not required by a literal path.
const { complain } = require(['.', 'helper.cjs'].join('/'))

it('complains through a helper', () => {
  complain('from the helper')
  console.warn('a direct warning')
  console.log('plain')
  expect(1).toBe(1)
})
