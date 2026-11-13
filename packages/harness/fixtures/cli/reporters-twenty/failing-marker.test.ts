describe('failing', () => {
  it.failing('is expected to fail and does', () => {
    expect(1).toBe(2)
  })

  it.failing('is expected to fail and passes', () => {
    expect(1).toBe(1)
  })
})
