describe('outer', () => {
  it('first', () => {
    throw new Error('a body that must not run')
  })
  describe('inner', () => {
    it('second', () => {})
    it.skip('skipped one', () => {})
    it.todo('todo one')
  })
  it.each([
    [1, 2],
    [3, 4],
  ])('each %i', () => {})
})
