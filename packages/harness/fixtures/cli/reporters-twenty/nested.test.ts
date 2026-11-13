describe('outer', () => {
  describe('middle', () => {
    describe('inner', () => {
      it('is deep', () => {
        expect('deep').toHaveLength(4)
      })
    })

    it('is shallow', () => {
      expect(true).toBe(true)
    })
  })
})
