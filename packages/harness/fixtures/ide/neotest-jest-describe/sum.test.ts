describe('sum', () => {
  // Every test that runs waits 20 ms, so Jest's verbose list shows a time after each one on every run.
  beforeEach(() => new Promise((resolve) => setTimeout(resolve, 20)))
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
  describe('nested', () => {
    it('handles (parens) and a-dash', () => {
      expect([1, 2]).toHaveLength(2)
    })
    it('fails inside', () => {
      expect('a').toBe('b')
    })
    describe('deeper', () => {
      it('goes deep', () => {
        expect(true).toBe(true)
      })
    })
  })
  describe.each([[1], [2]])('group %i', (n: number) => {
    it('has a number', () => {
      expect(n).toBeGreaterThan(0)
    })
  })
})
