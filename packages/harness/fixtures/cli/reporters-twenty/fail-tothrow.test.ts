describe('toThrow', () => {
  it('fails when nothing throws', () => {
    expect(() => 1).toThrow('x')
  })

  // The error is made in the test, not inside the callback: an error made while `toThrow` calls
  // the callback carries the `expect` package's frames, which Jest prints and Provino, whose
  // engine is its own, has none of (DV97).
  it('fails with another message', () => {
    const error = new Error('actual')
    expect(() => {
      throw error
    }).toThrow('expected')
  })
})
