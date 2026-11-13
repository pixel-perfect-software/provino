describe('thrown', () => {
  it('throws an error', () => {
    throw new Error('boom')
  })

  it('throws a TypeError', () => {
    const value = undefined as unknown as { missing: () => void }
    value.missing()
  })
})
