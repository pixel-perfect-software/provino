describe('assertion counts', () => {
  it('expect.assertions with the right count', async () => {
    expect.assertions(2)
    await Promise.resolve()
    expect(1).toBe(1)
    expect(2).toBe(2)
  })

  it('expect.hasAssertions', () => {
    expect.hasAssertions()
    expect('x').toBeTruthy()
  })

  it('counts passing assertions', () => {
    expect(1).toBe(1)
    expect(2).toBe(2)
    expect(3).toBe(3)
  })
})
