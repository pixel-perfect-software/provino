describe('thrown', () => {
  it('throws an error', () => {
    throw new Error('boom')
  })

  it('throws a string', () => {
    throw 'just a string'
  })
})
