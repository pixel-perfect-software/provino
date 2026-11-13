describe('basics', () => {
  it('adds', () => {
    expect(1 + 1).toBe(2)
  })

  it('compares objects', () => {
    expect({ a: 1, b: [1, 2] }).toEqual({ a: 1, b: [1, 2] })
  })
})
