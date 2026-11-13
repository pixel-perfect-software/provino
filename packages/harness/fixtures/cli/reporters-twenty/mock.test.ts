describe('mocks', () => {
  it('records calls', () => {
    const fn = jest.fn((x: number) => x * 2)
    fn(1)
    fn(2)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenLastCalledWith(2)
  })

  it('fails a call count', () => {
    const fn = jest.fn()
    fn()
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
