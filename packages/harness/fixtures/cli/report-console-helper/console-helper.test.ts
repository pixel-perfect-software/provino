const { complain } = require('./helper.cjs')

it('complains through a helper', () => {
  complain('from the helper')
  console.warn('a direct warning')
  console.log('plain')
  expect(1).toBe(1)
})
