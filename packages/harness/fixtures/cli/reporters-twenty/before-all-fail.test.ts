describe('hooks', () => {
  beforeAll(() => {
    throw new Error('setup broke')
  })

  it('never gets a good setup', () => {
    expect(1).toBe(1)
  })
})
