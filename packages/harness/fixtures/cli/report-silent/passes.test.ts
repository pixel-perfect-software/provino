describe('math', () => {
  it('adds', () => {
    expect(1 + 1).toBe(2)
  })

  describe('nested', () => {
    it('subtracts', () => {
      expect(3 - 1).toBe(2)
    })
  })
})

it('stands alone', () => {
  expect(true).toBe(true)
})
