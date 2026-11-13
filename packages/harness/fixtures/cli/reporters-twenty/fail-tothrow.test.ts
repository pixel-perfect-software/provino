describe('toThrow', () => {
  it('fails when nothing throws', () => {
    expect(() => 1).toThrow('x')
  })

  it('fails with another message', () => {
    expect(() => {
      throw new Error('actual')
    }).toThrow('expected')
  })
})
