describe('matchers', () => {
  it('matches text and arrays', () => {
    expect('provino').toMatch(/vin/)
    expect(['a', 'b']).toContain('b')
    expect({ a: 1, b: 2 }).toMatchObject({ a: 1 })
    expect([1, 2, 3]).toHaveLength(3)
  })
})
