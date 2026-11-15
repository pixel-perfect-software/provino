describe('sum', () => {
  it('adds', () => {
    expect(1 + 2).toBe(3)
  })
  it('fails', () => {
    expect(1 + 1).toBe(3)
  })
  it.skip('is skipped', () => {})
  it.todo('is todo')
  it.each([
    [1, 2],
    [3, 4],
  ])('each %i', (a: number, b: number) => {
    expect(b - a).toBe(1)
  })
  it('matches a stored snapshot', () => {
    expect('stored').toMatchSnapshot()
  })
})
